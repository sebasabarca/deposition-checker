export type ContradictionType = "direct" | "inferential" | "false_positive";

export type QAPair = { id: string; question: string; answer: string };

export type Finding = {
  t1_id: string;
  t2_id: string;
  t1_quote: string;
  t2_quote: string;
  type: ContradictionType;
  explanation: string;
  status: "verified" | "unverified";
  confidence: number | null;
  band: "high" | "medium" | "low" | null;
  priority: number;
  runsAgreeing: number;
  runsTotal: number;
  reasons: string[];
};

export type AnalyzeResponse = { t1: QAPair[]; t2: QAPair[]; findings: Finding[] };

// ---- v2: hand-duplicated from server/src/api (cases.ts, analyses.ts, depositions.ts). Update both
// when the API shape changes.

export type CaseSummary = {
  id: number;
  name: string;
  createdAt: string;
  depositions: number;
  witnesses: number;
  findings: number;
  lastAnalysis: { id: number; status: AnalysisStatus } | null;
};

export type DepositionStatus = "processing" | "ready" | "needs_review" | "unsupported" | "failed";
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
export type AnalysisRow = {
  id: number;
  witnessId: number;
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

export type FindingGroup = "contradictions" | "compatible" | "insufficient" | "review";
export type VerdictSource = "model" | "replayed" | "fixture";

export type AnalysisView = {
  id: number;
  caseId: number;
  witnessId: number;
  mode: "demo" | "live";
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
  depositions: { id: number; takenOn: string | null; status: DepositionStatus; originalFilename: string | null; witness: string }[];
  findings: { total: number; groups: Record<FindingGroup, number> };
  cost: { calls: number; actualUsd: number; budgetUsd: number; budgetSpentUsd: number; budgetReservedUsd: number };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type FindingSummary = {
  id: number;
  group: FindingGroup;
  classification: "direct" | "inferential" | "false_positive" | "insufficient_evidence";
  priority: "high" | "medium" | "low" | "needs_context";
  score: number | null;
  band: "high" | "medium" | "low" | null;
  evidenceStatus: "verified" | "approximate" | "wrong_reference" | "unsupported";
  unscoredReason: string | null;
  contextRequested: boolean;
  reviewState: string;
  source: VerdictSource;
  rank: number;
  a: { depositionId: number; ref: string | null };
  b: { depositionId: number; ref: string | null };
  sameEvent: "yes" | "no" | "uncertain";
  explanation: string;
};
export type FindingGroups = { groups: { group: FindingGroup; label: string; findings: FindingSummary[] }[] };

export type EvidenceLine = { id: number; ref: string; text: string; role: string; highlighted: boolean };
export type EvidenceSide = {
  exchangeId: string;
  deposition: { id: number; takenOn: string | null; originalFilename: string | null; witness: string };
  range: string | null;
  before: EvidenceLine[];
  lines: EvidenceLine[];
  after: EvidenceLine[];
  gapBefore: boolean;
  gapAfter: boolean;
  verification: { status: string; reason: string | null; location: string | null; bareAnswer: boolean; matchScore: number };
  attribution: { level: string; claude: string; codeRule: string | null; disagreement: string | null; qualifier: string | null; noRecall: boolean; approximation: boolean };
};
export type Factor = { component: "A" | "C" | "S" | "K" | "U"; label: string; points: number; max: number; origin: "code" | "claude" | "code+claude" };
export type Cap = { rule: string; limit: number; reason: string; binding: boolean };
export type FindingDetail = {
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
  rubricVersion: string;
  factors: Factor[];
  caps: Cap[];
  notCorroborated: string[];
  reasons: string[];
  consistencyIssues: string[];
  contextCheck: string | null;
  timeCheck: { status: string; detail: string } | null;
  source: { kind: VerdictSource; label: string; model: string; promptVersion: string; verdictId: number; replayOf: number | null };
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
