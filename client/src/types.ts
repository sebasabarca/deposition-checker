// ---- v2: hand-duplicated from server/src/api (cases.ts, findings.ts, caseRuns.ts, depositions.ts). Update both
// when the API shape changes.

export type CaseSummary = {
  id: number;
  name: string;
  createdAt: string;
  depositions: number;
  witnesses: number;
  findings: number;
  witnessNames: string[];
  reports: number;
  needsReview: number;
  checking: boolean;
  lastActivity: string;
  // The case's latest whole-case analysis (a case run).
  lastAnalysis: { id: number; status: CaseRunStatus } | null;
};

export type DepositionStatus = "processing" | "ready" | "needs_review" | "unsupported" | "failed";
// The session date the transcript states on its cover: a suggestion for the user to confirm.
export type DateFound = { date: string; ref: string; text: string };

export type DepositionRow = {
  id: number;
  witnessId: number;
  takenOn: string | null;
  status: DepositionStatus;
  error: string | null;
  pageCount: number | null;
  needsOcrPages: number[];
  originalFilename: string | null;
  fileSha256: string;
  createdAt: string;
  scanned: boolean;
  dateFound: DateFound | null;
  dateConfirmed?: string | null; // the date the person saved; a different cover date isn't raised again
};

export type OcrReadout = {
  engine: string;
  meanConfidence: number | null;
  lowConfidenceWords: number;
  annotations: { pdfPage: number; text: string }[];
  noiseWords: number;
  coverPages: number[];
  inferredPages: number[];
  markersCorrected: number;
};
export type DepositionView = {
  id: number;
  caseId: number;
  witness: { id: number; name: string };
  takenOn: string | null;
  originalFilename: string | null;
  status: DepositionStatus;
  error: string | null;
  ingestRun: number;
  parserVersion: string;
  pageCount: number | null;
  needsOcrPages: number[];
  blankPages: number[];
  sourceFormat: "pdf" | "html" | "text" | "rtf" | "docx";
  validation: { layout: string; pages: Record<string, number>; failedPages: number[]; reasons: unknown; ocr: OcrReadout | null; warnings?: string[] } | null;
  stored: { lines: number; exchanges: number; parts: number };
  dateFound: DateFound | null;
  dateConfirmed?: string | null;
  checks: number; // analyses that compared it: moving it deletes them
  createdAt: string;
};


export type CaseDetail = {
  case: { id: number; name: string; createdAt: string; findings: number };
  witnesses: { id: number; name: string; depositions: number[] }[];
  depositions: DepositionRow[];
  // The case's whole-case analyses, newest first (server/src/api/cases.ts caseDetail).
  runs: { id: number; name: string | null; status: CaseRunStatus; mode: "live" | "mock"; createdAt: string; finishedAt: string | null }[];
};

export type ReviewDecision = "confirmed" | "needs_context" | "dismissed";
// "quarantined": the transcript was re-read with a corrected parser after the finding was made, and its evidence
// changed. Kept for audit with its earlier review, never a current finding.
export type FindingGroup = "contradictions" | "needs_context" | "compatible" | "unverified" | "quarantined";
export type FindingStanding =
  | { state: "current" }
  | { state: "quarantined"; reason: string; since: string; parser: string | null; priorReview: { state: ReviewDecision | "unreviewed"; note: string | null; reviewedAt: string | null } };
export type VerdictSource = "model" | "replayed" | "fixture";

export type FindingSummary = {
  id: number;
  group: FindingGroup;
  classification: "direct" | "inferential" | "false_positive" | "insufficient_evidence";
  priority: "high" | "medium" | "low" | "needs_context" | "unverified";
  score: number | null;
  band: "high" | "medium" | "low" | null;
  evidenceStatus: "verified" | "approximate" | "wrong_reference" | "unsupported";
  unscoredReason: string | null;
  contextRequested: boolean;
  reviewState: string;
  reviewNote: string | null;
  standing: FindingStanding;
  subject: string | null;
  source: VerdictSource;
  model: string;
  modelName: string;
  direct: { modelClassification: string; evidenceKey: string; duplicates: number; ocrRead: boolean; lowOcrLines: string[]; speakers: string[] } | null; // null on a hybrid finding
  cross: { witnessA: string; witnessB: string } | null; // a conflict between two witnesses' accounts
  rank: number;
  a: { depositionId: number; ref: string | null };
  b: { depositionId: number; ref: string | null };
  sameEvent: "yes" | "no" | "uncertain";
  explanation: string;
};

// ocrConfidence is 0-100 for a line read by OCR, null for a text layer. pdfPage is the file's page,
// not the printed transcript page in ref. pageInferred: OCR couldn't read the printed page, so ref's
// page came from its neighbours; a server without this change omits it.
export type EvidenceLine = { id: number; ref: string; text: string; role: string; highlighted: boolean; ocrConfidence: number | null; pdfPage: number; pageInferred?: boolean };

export type TranscriptLine = { id: number; page: number; lineNo: number; pdfPage: number; speaker: string; text: string; ocrConfidence: number | null };
export type DepositionLines = { page: number | null; pages: number[]; lines: TranscriptLine[]; hits: TranscriptLine[]; moreHits: boolean };

// Mirrors server/src/jobs/caseRun.ts (CaseRunReport, caseRunFindings) and docs/case-run-api.md: a whole-case run
// over every witness and session of a case. A mock run uses the deterministic test model: no model, no cost.
// The request contract: packet-c3 (Focused Analysis, the default), packet-v1 (earlier Focused runs) or the
// experimental whole-stretch reading (stretch-v2, Contextual Analysis).
export type CaseRunContract = "packet-c3" | "packet-v1" | "stretch-v2";
// A packet-c3 run's pairs the model's screen dismissed: read, never findings, not verified evidence.
export type CaseRunCompact = { dismissed: number; byReason: Record<string, number>; note: string };
// A whole-stretch run's read pairs by status. no_conflict_identified and unclear pairs have no finding.
export type CaseRunStretch = { flagged: number; flagged_unverified: number; unclear: number; no_conflict_identified: number; related: number; note: string };
export type CaseRunStatus = "queued" | "retrieving" | "awaiting_confirmation" | "adjudicating" | "completed" | "incomplete" | "failed" | "blocked_budget" | "blocked_credentials" | "cancelled" | "interrupted" | "reconciling";
export type CoverageState = "complete" | "processed_with_unread" | "partial";
// economy: the same projection at Message Batches API prices (absent on runs prepared before economy mode existed).
export type CaseRunEconomyEstimate = { expectedUsd: number; noCacheUsd: number; worstCaseUsd: number; worstCasePerBatchUsd: number; recommendedBudgetUsd: number; batchSize: number; discount: number };
// reuse: requests whose exact request an earlier live run of this case already answered (exact-request reuse), found
// by rendering every planned request; an expectation, not a guarantee. checked is false when reuse doesn't apply.
export type CaseRunReuseEstimate = { checked: boolean; reusableRequests: number; expectedAvoidedUsd: number; economy: { expectedAvoidedUsd: number } };
export type CaseRunEstimate = { packets: number; listedPairs: number; splitPackets: number; oversizePackets: number; expectedUsd: number; noCacheUsd: number; largestPacketWorstCaseUsd: number; recommendedBudgetUsd: number; economy?: CaseRunEconomyEstimate; reuse?: CaseRunReuseEstimate; note: string };
export type CaseRunExecution = "standard" | "batch";
export type CaseRunBatches = { total: number; submitting: number; processing: number; awaitingImport: number; imported: number; notSubmitted: number; unknown: number; oldestOpenSince: string | null; resultsExpireAt: string | null; requests: Record<string, number> };
export type CaseRun = {
  // paidAvailable / economyAvailable: the server has its Anthropic API key, so Fast and Economy runs can be confirmed.
  // name: what the person called the analysis when they started it; null for runs started before names existed.
  name?: string | null;
  id: number; caseId: number; status: CaseRunStatus; mode: "live" | "mock"; execution: CaseRunExecution; contract?: CaseRunContract; scope?: { kind: "case" } | { kind: "depositions"; depositionIds: number[] }; stretch?: CaseRunStretch | null; compact?: CaseRunCompact | null; stretchAvailable?: boolean; economyAvailable?: boolean; paidAvailable?: boolean; economyBlocked?: "paid_off" | null; retentionAcknowledgedAt: string | null; batches: CaseRunBatches | null; error: string | null; model: string;
  createdAt: string; startedAt: string | null; finishedAt: string | null; confirmedAt: string | null; cancelRequested: boolean;
  estimate: CaseRunEstimate | null;
  coverageState: CoverageState; complete: boolean; incompleteReasons: string[];
  candidates: { total: number; adjudicated: number; incomplete: number; pending: number; deferred: number; uncovered: number; excluded: number; sameWitness: number; crossWitness: number };
  packets: { total: number; adjudicated: number; incomplete: number; failed: number; notStarted: number; inProgress: number; uncertain: number; retryable: number };
  findings: { type: string; priority: string; scored: boolean; n: number }[];
  reviewed?: number; // findings a person has decided
  // reused: requests answered by reusing the recorded response to an identical request from an earlier run of the
  // case (exact-request reuse): never sent, never charged. avoidedUsdEstimate is an estimate, not a charge.
  requests: { total: number; answered: number; failedNotBilled: number; uncertain: number; open: number; reused?: number };
  cost: { recordedCalls: number; costUsd: number; budget: { limitUsd: number; spentUsd: number; reservedUsd: number } | null; reuse?: { requests: number; avoidedUsdEstimate: number; fresh?: boolean } };
};
export type CaseRunSide = { exchange: string; depositionId: number; witnessId: number | null; witness: string | null; takenOn: string | null; range: string | null; lines: { id: number; at: string; text: string }[] };
export type CaseRunFinding = {
  id: number; crossWitness: boolean; type: string; priority: string; score: number | null; band: string | null; unscoredReason: string | null; evidenceStatus: string; reviewState: string; standing: FindingStanding;
  reviewNote: string | null; reviewedAt: string | null; evidenceEpochs: Record<string, number>; // the person's decision, and the transcript versions it is saved against
  verification: { a: { status: string | null; lineIds: number[] }; b: { status: string | null; lineIds: number[] } };
  a: CaseRunSide; b: CaseRunSide;
  model: { origin: "model" | "fixture"; model: string; promptVersion: string; outcome: string | null; verdict: unknown };
  safeguards: { rule: string; side: "a" | "b" | null; detail: string }[]; // code checks that moved a conflict verdict to needs context
};

// An analysis running now somewhere in the workspace (server/src/api/caseRuns.ts runningAnalysis). Veridict runs one
// at a time: a whole-case run (caseRunId) or an earlier two-session check (caseRunId null).
export type RunningAnalysis = { caseId: number; caseName: string; caseRunId: number | null };

// A finding as the cross-case screens list it (server/src/api/findings.ts WorkspaceFinding): one of each case's latest
// whole-case analysis, with its lane, the person's decision, both sides' citations and the model's explanation.
export type WorkspaceFinding = {
  id: number; runId: number; runName: string | null; caseId: number; caseName: string;
  lane: "contradictions" | "needs_context" | "compatible" | "unverified" | "quarantined";
  type: string; priority: string; score: number | null; evidenceStatus: string; reviewState: string; reviewedAt: string | null; crossWitness: boolean;
  a: { witness: string | null; takenOn: string | null; range: string | null };
  b: { witness: string | null; takenOn: string | null; range: string | null };
  explanation: string | null;
};
