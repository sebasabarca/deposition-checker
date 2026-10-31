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

import { countsToward, provenanceOf, type Provenance } from "../retrieve/provenance";

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

// Where every candidate of an analysis stands. Pure. Assessed and awaiting are separate on purpose: a
// selected candidate with no valid verdict yet (a budget stop, a failed request) is awaiting, not lost.
export type CandidateRow = { status: string; sources: readonly string[]; deferredReason: string | null; exclusionReason: string | null; selectedBy: string | null; n: number };
export type CandidateCoverage = {
  total: number;
  assessed: number;
  awaitingAssessment: number;
  deferred: { total: number; reasons: Record<string, number> };
  excluded: { total: number; reasons: Record<string, number> };
  audit: number;
  provenance: Record<Provenance, number>; // each candidate once
  foundBy: { pathA: number; pathB: number }; // a candidate both paths found counts in both
  selectedBy: { path_a: number; path_b: number };
};

export function candidateCoverage(rows: readonly CandidateRow[]): CandidateCoverage {
  const c: CandidateCoverage = { total: 0, assessed: 0, awaitingAssessment: 0, deferred: { total: 0, reasons: {} }, excluded: { total: 0, reasons: {} }, audit: 0, provenance: { path_a: 0, path_b: 0, both: 0, other: 0 }, foundBy: { pathA: 0, pathB: 0 }, selectedBy: { path_a: 0, path_b: 0 } };
  const bump = (group: { total: number; reasons: Record<string, number> }, reason: string | null, n: number) => {
    group.total += n;
    group.reasons[reason ?? "unspecified"] = (group.reasons[reason ?? "unspecified"] ?? 0) + n;
  };
  for (const r of rows) {
    c.total += r.n;
    if (r.status === "adjudicated") c.assessed += r.n;
    else if (r.status === "selected") c.awaitingAssessment += r.n;
    else if (r.status === "deferred") bump(c.deferred, r.deferredReason, r.n);
    else if (r.status === "excluded") bump(c.excluded, r.exclusionReason, r.n);
    else if (r.status === "audit") c.audit += r.n;
    c.provenance[provenanceOf(r.sources)] += r.n;
    if (countsToward(r.sources, "path_a")) c.foundBy.pathA += r.n;
    if (countsToward(r.sources, "path_b")) c.foundBy.pathB += r.n;
    if (r.selectedBy === "path_a" || r.selectedBy === "path_b") c.selectedBy[r.selectedBy] += r.n;
  }
  return c;
}

export type VerdictSource = "model" | "replayed" | "fixture";
export const SOURCE_LABELS: Record<VerdictSource, string> = {
  model: "Model assessment (Claude Sonnet), verified and scored by this application",
  replayed: "Demo: a stored Claude Sonnet assessment from an earlier run, replayed without a new model call",
  fixture: "Demo: a prepared example assessment for synthetic testimony. Not produced by a model",
};
