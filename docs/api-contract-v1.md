# Deposition Checker API contract v1

For the frontend agent. **Contract version 1, October 30, 2026.** Checked against `server/src/api/` on branch `v2-backend`.

Breaking changes get a new `docs/api-contract-v<n>.md`. Adding a field does not. `client/src/types.ts` hand-duplicates these shapes; section 8 lists what it is missing.

## 1. Conventions

- Base path `/api`. The Vite dev server proxies it to port 3001. These routes exist only when Postgres is reachable.
- JSON, except the PDF upload body. IDs are numbers. Dates are ISO strings; `takenOn` is `YYYY-MM-DD` or null.
- Errors: a non-2xx status with `{ "error": "<plain sentence, safe to show>" }`.
- Citations are `page:line` strings such as `148:05`. A range uses an en dash: `148:05–149:02`.
- Progress is counts, never a percentage. Don't derive a percentage and show it as coverage: processing everything isn't proof that every contradiction was found.
- Poll `GET /analyses/:id` while the status is active. There are no websockets.

**Display rules (architectural, not styling):**

- Testimony is shown only from `lines[].text`, `before[]` and `after[]`. Never show a model string as testimony.
- `explanation` and `alternativeExplanation` are Claude's and are labelled that way. Use `source.label` as given.
- `score` is application-calculated support, not a probability. `score` and `band` are null for unscored findings: show `unscoredExplanation`, never 0.
- Statement cards and topic names are never evidence. Neither is exposed as testimony by any endpoint.

## 2. Endpoints

| Screen | Method and path | Success | Errors |
| --- | --- | --- | --- |
| Case dashboard | `GET /cases` | 200 `{ cases: CaseSummary[] }` | |
| Case dashboard | `POST /cases` `{ name, witness? }` | 201 `CaseDetail` | 400 |
| Case and depositions | `GET /cases/:id` | 200 `CaseDetail` | 400, 404 |
| Depositions | `POST /cases/:id/witnesses` `{ name }` | 201 `{ witness: { id, name } }` | 400, 404, 409 duplicate |
| Depositions | `POST /cases/:caseId/depositions?witness=&takenOn=&filename=` with the PDF or UTF-8 text (a .txt transcript or pasted text) as the raw body; the bytes decide, not the Content-Type | 202 `{ created: true, deposition }`; 200 `{ created: false, deposition }` when the file is already in the case | 400, 404, 413 over 50 MB, 415 neither a PDF nor plain text |
| Depositions | `GET /depositions/:id` | 200 `{ deposition: DepositionView }` | 400, 404 |
| Depositions | `GET /depositions/:id/lines?page=&q=` | 200 `{ page, pages, lines, hits, moreHits }`: one printed page of stored lines (the first when `page` is absent or unknown) and up to 200 lines containing `q` | 400, 404 |
| Depositions | `GET /depositions/:id/pdf` (open at `#page=<pdfPage>`) | 200 the original file, inline: the PDF, or `text/plain` for a text deposition | 400, 404 |
| Depositions | `POST /depositions/:id/retry` | 202 `{ deposition }` | 404, 409 unless `failed` |
| Analysis | `POST /cases/:id/analyses` | 202 `{ created: true, analysis }`; 200 `{ created: false, analysis }` when an active one exists for the pair and mode | 400, 404 |
| Analysis | `GET /cases/:id/analyses` | 200 `{ analyses: AnalysisView[] }` | 400 |
| Analysis | `GET /analyses/:id` | 200 `{ analysis: AnalysisView }` | 400, 404 |
| Analysis | `POST /analyses/:id/resume` `{ budgetUsd?, retryInvalid? }` | 202 `{ analysis }` | 400 lower budget, 404, 409 not resumable |
| Analysis | `POST /analyses/:id/cancel` | 202 `{ analysis }` | 404, 409 not running |
| Findings | `GET /analyses/:id/findings` | 200 `FindingGroups` | 400, 404 |
| Review | `GET /findings/:id` | 200 `{ finding: FindingDetail }` | 400, 404 |

**Not built:** saving a review decision (`POST /findings/:id/review` in DESIGN.md), `GET /cases/:id/findings`, server-side filters and pagination, `GET /cases/:id/estimate`. Show `reviewState` read-only until the review endpoint exists.

**Filters:** `GET /analyses/:id/findings` returns every finding, so filter in the client. Filterable fields are `classification`, `band`, `priority`, `evidenceStatus`, `reviewState`, `source` and `group`.

## 3. Case dashboard

```ts
type CaseSummary = {
  id: number; name: string; createdAt: string
  depositions: number; witnesses: number
  findings: number // of the latest analysis only
  lastAnalysis: { id: number; status: AnalysisStatus } | null
}
```

## 4. Case and deposition management

```ts
type CaseDetail = {
  case: { id: number; name: string; createdAt: string; findings: number }
  witnesses: { id: number; name: string; depositions: number[] }[]
  depositions: DepositionRow[]
  analyses: AnalysisRow[] // a short form: use GET /analyses/:id for coverage
}
type DepositionStatus = 'processing' | 'ready' | 'needs_review' | 'unsupported' | 'failed'
type DepositionRow = {
  id: number; witnessId: number; takenOn: string | null; status: DepositionStatus
  error: string | null; pageCount: number | null; needsOcrPages: number[]
  originalFilename: string | null
  fileSha256: string // first 12 characters here
  createdAt: string
}
type DepositionView = {
  id: number; caseId: number; witness: { id: number; name: string }
  takenOn: string | null; originalFilename: string | null
  status: DepositionStatus; error: string | null; ingestRun: number; parserVersion: string
  pageCount: number | null; needsOcrPages: number[]; blankPages: number[]
  validation: { layout: string; pages: Record<string, number>; failedPages: number[]; reasons: unknown
    ocr: { engine: string; meanConfidence: number | null; lowConfidenceWords: number; annotations: { pdfPage: number; text: string }[]; noiseWords: number; coverPages: number[]; inferredPages: number[]; markersCorrected: number; pipesCorrected: number } | null // NEW
  } | null
  stored: { lines: number; exchanges: number; parts: number }
  createdAt: string
}
```

Only `ready` depositions can be analyzed. Fields read from the file are null while `processing`, never placeholders. `failed` is the only status that can be retried.

## 5. Analysis progress and coverage

```ts
// POST /cases/:id/analyses body. Only depositionA and depositionB are required.
type StartAnalysis = {
  depositionA: number; depositionB: number
  mode?: 'demo' | 'live'           // default demo; demo never calls a model
  method?: 'direct_fable' | 'hybrid' // default direct_fable for live, hybrid for demo
  budgetUsd?: number               // default 6 direct, 3 hybrid, at most 20
  maxCandidates?: number           // default 300, at most 300
  promptVersion?: string; effort?: string
  strategy?: string                // default C: one pair per request, ten at a time
  maxConcurrency?: number
}
type AnalysisStatus = 'queued' | 'parsing' | 'retrieving' | 'adjudicating' | 'completed'
  | 'failed' | 'blocked_budget' | 'blocked_credentials' | 'cancelled' | 'interrupted'
// Active: queued, parsing, retrieving, adjudicating. Resumable: failed, blocked_budget,
// blocked_credentials, cancelled, interrupted.

type AnalysisView = {
  id: number; caseId: number; witnessId: number
  mode: 'demo' | 'live'
  retrieval: 'pair' | 'hybrid'     // NEW. Always hybrid for new analyses; pair appears only on past ones
  status: AnalysisStatus; error: string | null
  progress: AnalysisProgress
  coverage: AnalysisCoverage       // NEW
  promptVersion: string; effort: string; maxCandidates: number
  strategy: string; candidatesPerRequest: number; maxConcurrency: number
  cancelRequested: boolean
  depositions: { id: number; takenOn: string | null; status: DepositionStatus; originalFilename: string | null; witness: string }[]
  findings: { total: number; groups: Record<FindingGroup, number> }
  cost: { calls: number; actualUsd: number; budgetUsd: number; budgetSpentUsd: number; budgetReservedUsd: number }
  createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string
}
type AnalysisProgress = { // every field optional: present once its stage has run
  candidates?: { selected: number; deferred: number; excluded?: number }
  adjudicated?: number; replayed?: number; fixture?: number; withoutVerdict?: number
  failed?: number; rateLimited?: number; oversize?: number; requests?: number
  peakConcurrency?: number; findings?: number; parsingChecks?: number
  // hybrid only, NEW:
  retrievalVersion?: string
  pool?: {
    selected: number; deferred: number; excluded: number
    pathA: number; pathB: number; both: number
    selectedBy: { path_a: number; path_b: number }
    targets: { path_a: number; path_b: number }
    redistributed: number
  }
  cardsStage?: { sessions: number; cards: number; rejected: number; failedChunks: number; thinChunks: number; stopped: string | null
    topics: 'built' | 'unchanged' | 'no_cards' | 'failed' | 'not_built'; topicError: string | null }
}
type AnalysisCoverage = { // NEW
  candidates: {
    total: number
    assessed: number             // has a valid verdict
    awaitingAssessment: number   // selected, no verdict yet: a budget stop or a failed request
    deferred: { total: number; reasons: Record<string, number> }
      // cap | budget | not_the_witness_assertion | no_assertion_on_either_side | side_not_answered
    excluded: { total: number; reasons: Record<string, number> } // 0 for hybrid: a card label never excludes testimony
    audit: number
    provenance: { path_a: number; path_b: number; both: number; other: number } // each candidate once
    foundBy: { pathA: number; pathB: number } // a candidate both found counts in both
    selectedBy: { path_a: number; path_b: number }
  }
  cards: CardSummary[] | null    // hybrid only: one per session
  topics: (TopicReport & { mapVersion: number }) | null // hybrid only, once a map exists
}
type CardSummary = {
  depositionId: number
  parts: number
  procedural: number | null      // null until a run has counted them
  coverage: { carded: number; no_assertion: number; suspected_omission: number; omitted: number; failed: number; not_processed: number }
  cards: { usable: number; rejected: number; duplicates: number; negatedStatements: number; sourceGroundingRate: number | null }
  rejectionReasons: Record<string, number>
}
type TopicReport = {
  topics: number; cards: number; assigned: number; unassigned: number
  topicCoverage: number | null; multiTopicCards: number
  fragmentation: { singleSession: number; singletons: number; nearDuplicateNames: string[][]; largestTopicShare: number | null }
}
```

Coverage ledger: `assessed + awaitingAssessment + deferred.total + excluded.total + audit = total`. In a partial banner, use `assessed` of `assessed + awaitingAssessment`. `coverage.candidates` is empty until retrieval saves its candidates; for pair analyses `cards` and `topics` are null. `suspected_omission`, `omitted`, `failed` and `not_processed` are testimony the cards may have missed: show them, and never fold them into `no_assertion`. All of them stay searchable by Path B.

## 6. Findings and filters

A live analysis defaults to `method: 'direct_fable'` (`POST /cases/:id/analyses` also takes `method: 'hybrid'`; a demo is always hybrid, and `direct_fable` with `mode: 'demo'` returns 400). An active analysis is reused only for the same depositions, mode and method. `resumable` says whether resuming can make progress; resuming a direct analysis that can't returns 409, because no paid attempt repeats. `AnalysisView` gains `retrieval` and `discovery`, which is null on a hybrid analysis: `{ resultModel, resultModelName, usedFallback, fallbackModel, primaryModel, promptVersion, sourceHashes, attempts: [{ attempt, role, model, modelName, status, batchId, stopReason, refusalCategory, error, costUsd, inputTokens, outputTokens, thinkingTokens, latencyMs }] }`. `GET /analyses/:id/findings` adds `notStored`: proposals whose citations resolve to no stored line. Each finding adds `model`, `modelName` and `direct` (null on a hybrid finding), and `GET /findings/:id` adds `source.modelName`, `source.usedFallback` and `direct`. A direct finding's `score` is evidence strength (`rubricVersion: 'evidence-strength-v1'`, five checks in `factors`), null when the evidence needs review or the finding is compatible. It is not a probability, and sets neither the lane nor the priority. `priority` adds `unverified`.

```ts
type FindingGroup = 'contradictions' | 'needs_context' | 'compatible' | 'unverified'
type FindingGroups = { groups: { group: FindingGroup; label: string; findings: FindingSummary[] }[] } // all four, always
type FindingSummary = {
  id: number; group: FindingGroup
  classification: 'direct' | 'inferential' | 'false_positive' | 'insufficient_evidence'
  priority: 'high' | 'medium' | 'low' | 'needs_context'
  score: number | null; band: 'high' | 'medium' | 'low' | null
  evidenceStatus: 'verified' | 'approximate' | 'wrong_reference' | 'unsupported'
  unscoredReason: string | null; contextRequested: boolean; reviewState: string
  source: 'model' | 'replayed' | 'fixture'
  rank: number // the pool's assessment order, not a quality measure
  a: { depositionId: number; ref: string | null }
  b: { depositionId: number; ref: string | null }
  sameEvent: 'yes' | 'no' | 'uncertain'
  explanation: string // Claude's
}
```

`wrong_reference` and `unsupported` findings are always in `unverified`. Show them in the dashed "Check manually" section with no band.

## 7. Side-by-side testimony review

```ts
type EvidenceLine = { id: number; ref: string; text: string; role: string; highlighted: boolean; ocrConfidence: number | null; pdfPage: number; pageInferred: boolean }
// NEW: ocrConfidence not null means OCR. Label the passage "Read by OCR", show the value per line, and flag lines below 85. Link to GET /depositions/:id/pdf#page=<pdfPage>. pageInferred means OCR could not read this page's printed number, so its page:line citation was inferred from the neighbouring pages: warn on it.
type EvidenceSide = {
  exchangeId: string
  deposition: { id: number; takenOn: string | null; originalFilename: string | null; witness: string }
  range: string | null
  before: EvidenceLine[]; lines: EvidenceLine[]; after: EvidenceLine[]
  gapBefore: boolean; gapAfter: boolean // pages omitted: show a gap marker, never join across it
  verification: { status: string; reason: string | null; location: string | null; bareAnswer: boolean; matchScore: number } // code's
  attribution: { level: string; claude: string; codeRule: string | null; disagreement: string | null; qualifier: string | null; noRecall: boolean; approximation: boolean }
}
type Factor = { component: 'A' | 'C' | 'S' | 'K' | 'U'; label: string; points: number; max: number; origin: 'code' | 'claude' | 'code+claude' }
type Cap = { rule: string; limit: number; reason: string; binding: boolean }
type FindingDetail = {
  id: number; analysisId: number | null; group: FindingGroup; groupLabel: string
  classification: FindingSummary['classification']; priority: FindingSummary['priority']
  score: number | null; band: FindingSummary['band']
  unscoredReason: string | null; unscoredExplanation: string | null
  evidenceStatus: FindingSummary['evidenceStatus']; contextRequested: boolean
  rubricVersion: string; factors: Factor[]; caps: Cap[]
  notCorroborated: string[]; reasons: string[]; consistencyIssues: string[]
  contextCheck: string | null; timeCheck: { status: string; detail: string } | null
  source: { kind: 'model' | 'replayed' | 'fixture'; label: string; model: string; promptVersion: string; verdictId: number; replayOf: number | null }
  assessment: { // Claude's, except where a field says otherwise
    sameEvent: string; scopeAligned: string; conflictBasis: string; falsePositiveReason: string | null
    explanation: string; alternativeExplanation: string | null; alternativeSupport: string | null
    inferenceSteps: { statement: string; supportingIds: string[] }[]
    unestablishedAssumptions: string[]; needsMoreContext: boolean
  }
  a: EvidenceSide; b: EvidenceSide // a is the earlier session
}
```

Show `a` on the left and `b` on the right. `verification` is labelled as a code check, and `attribution.claude` as Claude's reading.

## 8. Changes the client needs

No existing field changed or moved. Add to `client/src/types.ts`:

0. `EvidenceLine.ocrConfidence` and `validation.ocr` for scanned depositions.
1. `AnalysisView.retrieval` and `AnalysisView.coverage`, with `AnalysisCoverage`, `CardSummary` and `TopicReport`.
2. In `AnalysisProgress`: `candidates.excluded`, `pool`, `retrievalVersion`, `cardsStage`, and the existing `rateLimited`, `oversize`, `requests`, `peakConcurrency`, `retryInvalid`.
3. New analyses are hybrid automatically. A live run needs `ALLOW_PAID_CALLS=true`, or it stops as `blocked_credentials` before any call.

Review decisions: `PATCH /findings/:id/review` takes `{ decision: 'confirmed' | 'needs_context' | 'dismissed' | null, note? }`; null clears it. A decision carries into a later report citing the same passages. `FindingSummary` and `FindingDetail` add `reviewNote`, and detail adds `reviewedAt`. `CaseSummary` adds `witnessNames`, `reports`, `needsReview`, `checking` and `lastActivity`; `DepositionRow` adds `scanned`; `AnalysisView.findings` adds `decided`.
