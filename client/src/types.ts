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
