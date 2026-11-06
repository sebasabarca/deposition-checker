// ---- v2: hand-duplicated from server/src/api (cases.ts, analyses.ts, depositions.ts). Update both
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
  lastAnalysis: { id: number; status: AnalysisStatus } | null;
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

export type AnalysisStatus = "queued" | "parsing" | "retrieving" | "adjudicating" | "completed" | "failed" | "blocked_budget" | "blocked_credentials" | "cancelled" | "interrupted";
export type AnalysisProgress = {
  candidates?: { selected: number; deferred: number };
  adjudicated?: number;
  replayed?: number;
  fixture?: number;
  withoutVerdict?: number;
  failed?: number;
  findings?: number;
  parsingChecks?: number;
};
export type AnalysisKind = "same_witness" | "cross_witness";

export type AnalysisRow = {
  id: number;
  kind: AnalysisKind;
  witnessId: number;
  witnessBId: number | null; // witness B of a cross-witness check
  depositionA: number;
  depositionB: number;
  mode: "demo" | "live";
  status: AnalysisStatus;
  progress: AnalysisProgress;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type CaseDetail = {
  case: { id: number; name: string; createdAt: string; findings: number };
  witnesses: { id: number; name: string; depositions: number[] }[];
  depositions: DepositionRow[];
  analyses: AnalysisRow[];
};

export type ReviewDecision = "confirmed" | "needs_context" | "dismissed";
// "quarantined": the transcript was re-read with a corrected parser after the finding was made, and its evidence
// changed. Kept for audit with its earlier review, never a current finding.
export type FindingGroup = "contradictions" | "needs_context" | "compatible" | "unverified" | "quarantined";
export type FindingStanding =
  | { state: "current" }
  | { state: "quarantined"; reason: string; since: string; parser: string | null; priorReview: { state: ReviewDecision | "unreviewed"; note: string | null; reviewedAt: string | null } };
export type VerdictSource = "model" | "replayed" | "fixture";

export type DiscoveryAttempt = {
  attempt: number;
  role: "primary" | "fallback";
  model: string;
  modelName: string;
  status: string;
  batchId: string | null;
  stopReason: string | null;
  refusalCategory: string | null;
  error: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  latencyMs: number | null;
};
export type DiscoveryView = {
  resultModel: string | null;
  resultModelName: string | null;
  usedFallback: boolean;
  fallbackModel: string;
  primaryModel: string;
  promptVersion: string;
  sourceHashes: unknown;
  attempts: DiscoveryAttempt[];
};

export type AnalysisView = {
  id: number;
  caseId: number;
  witnessId: number;
  kind: AnalysisKind;
  witnesses: { a: { id: number; name: string }; b: { id: number; name: string } | null };
  mode: "demo" | "live";
  retrieval: "direct_fable" | "hybrid" | "pair";
  discovery: DiscoveryView | null;
  evidence: EvidenceCoverage | null; // direct analyses: what testimony the check received
  resumable: boolean; // whether resuming can make progress
  status: AnalysisStatus;
  error: string | null;
  progress: AnalysisProgress;
  promptVersion: string;
  strategy: string;
  candidatesPerRequest: number;
  maxConcurrency: number;
  cancelRequested: boolean;
  effort: string;
  maxCandidates: number;
  // Every session compared, side A's first, each side in date order.
  depositions: { id: number; takenOn: string | null; status: DepositionStatus; originalFilename: string | null; witness: string; witnessId: number; side: "A" | "B" }[];
  findings: { total: number; groups: Record<FindingGroup, number>; decided: number };
  cost: { calls: number; actualUsd: number; budgetUsd: number; budgetSpentUsd: number; budgetReservedUsd: number };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

// Mirrors server/src/verify/coverage.ts: worked out by code from what ingestion stored.
export type CoverageGap = { after: string; before: string; missingPages: number[] };
export type SessionCoverage = { depositionId: number; linesSent: number; pageCount: number | null; blankPages: number[]; unreadPages: number[]; gaps: CoverageGap[]; lineSkips: CoverageGap[]; numbered: boolean; notes: string[] }; // notes: the server's sentences for what's missing
// model: what the model itself said limited its review; null when it gave no answer.
export type EvidenceCoverage = { sessions: SessionCoverage[]; model: { completionStatus: "complete" | "partial"; limitations: string[] } | null };

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
// Proposed findings whose citations couldn't be tied to stored lines, so they have no finding to open.
export type NotStoredFinding = { findingId: string; model: string; modelName: string; classification: string; evidenceStatus: string; reasons: string[]; citationA: string; citationB: string; explanation: string };
export type FindingGroups = { groups: { group: FindingGroup; label: string; findings: FindingSummary[] }[]; notStored?: NotStoredFinding[] };

// ocrConfidence is 0-100 for a line read by OCR, null for a text layer. pdfPage is the file's page,
// not the printed transcript page in ref. pageInferred: OCR couldn't read the printed page, so ref's
// page came from its neighbours; a server without this change omits it.
export type EvidenceLine = { id: number; ref: string; text: string; role: string; highlighted: boolean; ocrConfidence: number | null; pdfPage: number; pageInferred?: boolean };
export type EvidenceSide = {
  exchangeId: string;
  // physicalLines: a PDF without printed line numbers; its references count rows on the page.
  deposition: { id: number; takenOn: string | null; originalFilename: string | null; witness: string; physicalLines?: boolean };
  range: string | null;
  before: EvidenceLine[];
  lines: EvidenceLine[];
  after: EvidenceLine[];
  gapBefore: boolean;
  gapAfter: boolean;
  verification: { status: string; reason: string | null; location: string | null; bareAnswer: boolean; matchScore: number };
  attribution: { level: string; claude: string; codeRule: string | null; disagreement: string | null; qualifier: string | null; noRecall: boolean; approximation: boolean };
};
export type Factor = { component: "A" | "C" | "S" | "K" | "U" | "E"; label: string; points: number; max: number; origin: "code" | "claude" | "code+claude"; detail?: string };
export type Cap = { rule: string; limit: number; reason: string; binding: boolean };
export type DirectSideCheck = { speaker: string; ocr: { read: boolean; minConfidence: number | null; lowLines: string[] }; reportedSpeech: boolean };
// How a witness knows what they said, as the model read it (cross-witness findings).
export type KnowledgeBasis = "personal_observation" | "told_by_someone" | "belief_or_inference" | "unclear";

export type FindingDetail = {
  cross: { witnessA: string; witnessB: string; sessionA: string | null; sessionB: string | null; basisA: KnowledgeBasis; basisB: KnowledgeBasis } | null;
  id: number;
  analysisId: number | null;
  group: FindingGroup;
  groupLabel: string;
  classification: FindingSummary["classification"];
  priority: FindingSummary["priority"];
  score: number | null;
  band: FindingSummary["band"];
  unscoredReason: string | null;
  unscoredExplanation: string | null;
  evidenceStatus: FindingSummary["evidenceStatus"];
  contextRequested: boolean;
  reviewState: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  standing: FindingStanding;
  evidenceEpochs: Record<string, number>; // the evidence versions this detail was read at; a review is saved only against them
  rubricVersion: string;
  factors: Factor[];
  caps: Cap[];
  notCorroborated: string[];
  reasons: string[];
  consistencyIssues: string[];
  contextCheck: string | null;
  timeCheck: { status: string; detail: string } | null;
  source: { kind: VerdictSource; label: string; model: string; modelName: string; usedFallback: boolean; promptVersion: string; verdictId: number; replayOf: number | null };
  direct: {
    modelClassification: string;
    evidenceKey: string;
    duplicates: { findingId: string; classification: string; a: string; b: string; explanation: string }[];
    sharedSubject: string | null;
    missingContext: string | null;
    reasoning: string | null;
    conflictBasis: string | null;
    a: DirectSideCheck;
    b: DirectSideCheck;
  } | null;
  assessment: {
    sameEvent: string;
    scopeAligned: string;
    conflictBasis: string;
    falsePositiveReason: string | null;
    explanation: string;
    alternativeExplanation: string | null;
    alternativeSupport: string | null;
    inferenceSteps: { statement: string; supportingIds: string[] }[];
    unestablishedAssumptions: string[];
    needsMoreContext: boolean;
  };
  a: EvidenceSide;
  b: EvidenceSide;
};

export type TranscriptLine = { id: number; page: number; lineNo: number; pdfPage: number; speaker: string; text: string; ocrConfidence: number | null };
export type DepositionLines = { page: number | null; pages: number[]; lines: TranscriptLine[]; hits: TranscriptLine[]; moreHits: boolean };

// Mirrors server/src/api/caseAnalysis.ts: a stored hand-authored whole-case analysis, every citation
// resolved by code to the stored transcript lines (only those are shown).
export type CaseAnalysisLine = { id: number; ref: string; text: string; role: string; highlighted: boolean };
export type CaseAnalysisCitation = { sessionId: string; witness: string; date: string; depositionId: number | null; status: "verified" | "unverified"; reason: string | null; range: string | null; lines: CaseAnalysisLine[] };
export type CaseAnalysisSession = { id: string; witness: string; date: string; depositionId: number | null };
export type CaseAnalysisView = {
  provenance: { origin: "hand_authored_demo"; source_basis: string; authoring_method: string; live_model_execution: false; model: null; analysis_run_id: null };
  execution: { status: "not_run"; paid_calls: 0; cost_usd: 0; claims_live_analysis: false };
  coverage: { sessions_total: number; witnesses_total: number; unique_pairs_total: number; pairs_complete: number; pairs_deferred: number; pairs_unprocessed: number; findings_total: number; findings_by_classification: Record<string, number>; coverage_claim: string };
  edits: string;
  sessions: CaseAnalysisSession[];
  pairs: { pair_id: string; session_ids: [string, string]; relationship: "within_witness" | "cross_witness"; status: "complete" | "deferred" | "unprocessed"; finding_count: number; sessions: CaseAnalysisSession[] }[];
  findings: { id: string; pair_id: string; relationship: "within_witness" | "cross_witness"; classification: "incompatible" | "uncertain" | "compatible"; priority: "high" | "medium" | "low"; topic: string; summary: string; citations: [CaseAnalysisCitation, CaseAnalysisCitation] }[];
  unverified: number;
};

// Mirrors server/src/jobs/caseRun.ts (CaseRunReport, caseRunFindings) and docs/case-run-api.md: a whole-case run
// over every witness and session of a case. A mock run uses the deterministic test model: no model, no cost.
// The request contract: packet-v1 (the default) or the experimental whole-stretch reading (stretch-v2).
export type CaseRunContract = "packet-v1" | "stretch-v2";
// A whole-stretch run's read pairs by status. no_conflict_identified and unclear pairs have no finding.
export type CaseRunStretch = { flagged: number; flagged_unverified: number; unclear: number; no_conflict_identified: number; related: number; note: string };
export type CaseRunStatus = "queued" | "retrieving" | "awaiting_confirmation" | "adjudicating" | "completed" | "incomplete" | "failed" | "blocked_budget" | "blocked_credentials" | "cancelled" | "interrupted" | "reconciling";
export type CoverageState = "complete" | "processed_with_unread" | "partial";
// economy: the same projection at Message Batches API prices (absent on runs prepared before economy mode existed).
export type CaseRunEconomyEstimate = { expectedUsd: number; noCacheUsd: number; worstCaseUsd: number; worstCasePerBatchUsd: number; recommendedBudgetUsd: number; batchSize: number; discount: number };
export type CaseRunEstimate = { packets: number; listedPairs: number; splitPackets: number; oversizePackets: number; expectedUsd: number; noCacheUsd: number; largestPacketWorstCaseUsd: number; recommendedBudgetUsd: number; economy?: CaseRunEconomyEstimate; note: string };
export type CaseRunExecution = "standard" | "batch";
export type CaseRunBatches = { total: number; submitting: number; processing: number; awaitingImport: number; imported: number; notSubmitted: number; unknown: number; oldestOpenSince: string | null; resultsExpireAt: string | null; requests: Record<string, number> };
export type CaseRun = {
  // paidAvailable / economyAvailable: the server has its Anthropic API key, so Fast and Economy runs can be confirmed.
  // name: what the person called the analysis when they started it; null for runs started before names existed.
  name?: string | null;
  id: number; caseId: number; status: CaseRunStatus; mode: "live" | "mock"; execution: CaseRunExecution; contract?: CaseRunContract; scope?: { kind: "case" } | { kind: "depositions"; depositionIds: number[] }; stretch?: CaseRunStretch | null; stretchAvailable?: boolean; economyAvailable?: boolean; paidAvailable?: boolean; economyBlocked?: "paid_off" | null; retentionAcknowledgedAt: string | null; batches: CaseRunBatches | null; error: string | null; model: string;
  createdAt: string; startedAt: string | null; finishedAt: string | null; confirmedAt: string | null; cancelRequested: boolean;
  estimate: CaseRunEstimate | null;
  coverageState: CoverageState; complete: boolean; incompleteReasons: string[];
  candidates: { total: number; adjudicated: number; incomplete: number; pending: number; deferred: number; uncovered: number; excluded: number; sameWitness: number; crossWitness: number };
  packets: { total: number; adjudicated: number; incomplete: number; failed: number; notStarted: number; inProgress: number; uncertain: number; retryable: number };
  findings: { type: string; priority: string; scored: boolean; n: number }[];
  // reused: requests answered by reusing the recorded response to an identical request from an earlier run of the
  // case (exact-request reuse): never sent, never charged. avoidedUsdEstimate is an estimate, not a charge.
  requests: { total: number; answered: number; failedNotBilled: number; uncertain: number; open: number; reused?: number };
  cost: { recordedCalls: number; costUsd: number; budget: { limitUsd: number; spentUsd: number; reservedUsd: number } | null; reuse?: { requests: number; avoidedUsdEstimate: number } };
};
export type CaseRunSide = { exchange: string; depositionId: number; witnessId: number | null; witness: string | null; takenOn: string | null; range: string | null; lines: { id: number; at: string; text: string }[] };
export type CaseRunFinding = {
  id: number; crossWitness: boolean; type: string; priority: string; score: number | null; band: string | null; unscoredReason: string | null; evidenceStatus: string; reviewState: string; standing: FindingStanding;
  verification: { a: { status: string | null; lineIds: number[] }; b: { status: string | null; lineIds: number[] } };
  a: CaseRunSide; b: CaseRunSide;
  model: { origin: "model" | "fixture"; model: string; promptVersion: string; outcome: string | null; verdict: unknown };
  safeguards: { rule: string; side: "a" | "b" | null; detail: string }[]; // code checks that moved a conflict verdict to needs context
};
