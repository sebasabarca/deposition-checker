// How findings are grouped and labelled for a lawyer. Pure: no I/O.
//
// Four sections, never mixed:
//   contradictions  verified, scored direct or inferential findings: potential contradictions
//   compatible      verified, scored false positives: likely compatible testimony. Their score is
//                   support for "not a contradiction", never a probability of contradiction.
//   insufficient    Claude couldn't judge from the packet
//   review          everything code couldn't stand behind: unverified citations, verdicts whose own
//                   fields disagree, no attributable witness statement, or missing context
//                   preventing a defensible assessment
// And where the verdict came from: a live model call, a stored model verdict replayed in a demo, or
// a prepared synthetic fixture.

export type FindingGroup = "contradictions" | "compatible" | "insufficient" | "review";
export type FindingRow = {
  type: string;
  evidenceStatus: string;
  score: number | null;
  unscoredReason: string | null;
  priority: string;
};

export function findingGroup(f: FindingRow): FindingGroup {
  if (f.evidenceStatus === "wrong_reference" || f.evidenceStatus === "unsupported") return "review";
  if (f.type === "insufficient_evidence" || f.unscoredReason === "insufficient_evidence") return "insufficient";
  if (f.score === null || f.priority === "needs_context") return "review";
  return f.type === "false_positive" ? "compatible" : "contradictions";
}

export const GROUP_LABELS: Record<FindingGroup, string> = {
  contradictions: "Potential contradictions",
  compatible: "Likely compatible testimony",
  insufficient: "Insufficient evidence",
  review: "Needs your review",
};

const PRIORITY_ORDER = ["high", "medium", "low", "needs_context"];
export function compareFindings(a: { id: number; priority: string; score: number | null }, b: { id: number; priority: string; score: number | null }): number {
  return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || (b.score ?? -1) - (a.score ?? -1) || a.id - b.id;
}

// Why an unscored finding has no score, in plain words.
export const UNSCORED_REASONS: Record<string, string> = {
  evidence: "A quoted phrase couldn't be found where the verdict cited it, so the finding isn't scored. Check it manually.",
  insufficient_evidence: "The adjudicator said the two passages alone don't allow a judgement.",
  no_witness_assertion: "Neither passage is a statement the witness clearly made or adopted.",
  inconsistent_verdict: "The verdict's own fields contradict each other, so it isn't scored. Read both passages yourself.",
};

export type VerdictSource = "model" | "replayed" | "fixture";
export const SOURCE_LABELS: Record<VerdictSource, string> = {
  model: "Model assessment (Claude Sonnet), verified and scored by this application",
  replayed: "Demo: a stored Claude Sonnet assessment from an earlier run, replayed without a new model call",
  fixture: "Demo: a prepared example assessment for synthetic testimony. Not produced by a model",
};
