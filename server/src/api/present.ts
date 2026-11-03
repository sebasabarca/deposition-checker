// How findings are grouped and labelled for a lawyer. Pure: no I/O.
//
// Four sections, never mixed:
//   contradictions  source-verified direct or inferential findings: potential contradictions for a
//                   lawyer to weigh, never proven ones
//   needs_context   they may conflict, but the evidence is incomplete or qualified, the model couldn't
//                   judge, or code couldn't stand behind who said it
//   compatible      verified false positives. A hybrid finding's score here is support for "not a
//                   contradiction", never a probability of contradiction.
//   unverified      the source checks failed: invalid references, unsupported quotations, or words
//                   that aren't the witness's testimony
// And where the verdict came from: a live model call, a stored model verdict replayed in a demo, or
// a prepared synthetic fixture.

import { countsToward, provenanceOf, type Provenance } from "../retrieve/provenance";

import type { SessionCoverage } from "../verify";

export type FindingGroup = "contradictions" | "needs_context" | "compatible" | "unverified";
export type FindingRow = {
  type: string;
  evidenceStatus: string;
  score: number | null;
  unscoredReason: string | null;
  priority: string;
};

export function findingGroup(f: FindingRow): FindingGroup {
  if (f.evidenceStatus === "wrong_reference" || f.evidenceStatus === "unsupported" || f.unscoredReason === "attribution_failed") return "unverified";
  if (f.type === "insufficient_evidence" || f.unscoredReason === "insufficient_evidence") return "needs_context";
  const scored = f.score !== null || f.unscoredReason === "direct_discovery"; // a compatible direct finding has no score to give
  if (!scored || f.priority === "needs_context") return "needs_context";
  return f.type === "false_positive" ? "compatible" : "contradictions";
}

export const GROUP_LABELS: Record<FindingGroup, string> = {
  contradictions: "Potential contradictions",
  needs_context: "Needs context",
  compatible: "Compatible or dismissed",
  unverified: "Unverified",
};
export const GROUP_ORDER: FindingGroup[] = ["contradictions", "needs_context", "compatible", "unverified"];

const PRIORITY_ORDER = ["high", "medium", "low", "needs_context", "unverified"];
export function compareFindings(a: { id: number; priority: string; score: number | null }, b: { id: number; priority: string; score: number | null }): number {
  return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || (b.score ?? -1) - (a.score ?? -1) || a.id - b.id;
}

// Why an unscored finding has no score, in plain words.
export const UNSCORED_REASONS: Record<string, string> = {
  evidence: "A quoted phrase couldn't be found where the verdict cited it, so the finding isn't scored. Check it manually.",
  insufficient_evidence: "The adjudicator said the two passages alone don't allow a judgement.",
  no_witness_assertion: "Neither passage is a statement the witness clearly made or adopted.",
  inconsistent_verdict: "The verdict's own fields contradict each other, so it isn't scored. Read both passages yourself.",
  attribution_failed: "A cited statement isn't the witness's testimony, so this can't be treated as a conflict in what the witness said.",
  needs_context: "Not scored: the evidence needs review first. Read both passages yourself.",
  direct_discovery: "Not applicable: this finding isn't a possible conflict, so it has no evidence strength.",
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
// The product never names the model or its provider to users: the primary model is "Veridict's
// analysis" and the fallback its "second reading". Stored rows keep the real model IDs.
// The model that answers only after a refusal: Opus for same-witness checks, Fable for cross-witness ones.
const FALLBACK_MODEL = { same: "claude-opus-5-5", cross: "claude-fable-5-1" };
export const modelName = (model: string, cross = false) => (model === FALLBACK_MODEL[cross ? "cross" : "same"] ? "Veridict's second reading" : "Veridict's analysis");
export const directSourceLabel = (model: string, fallback: boolean, cross = false) => `Proposed by ${modelName(model, cross)}${fallback ? ", after the first reading declined" : ""}, reading every stored line of ${cross ? "both witnesses' sessions" : "both sessions"}. Citations checked by Veridict against the transcript.`;
export const SOURCE_LABELS: Record<VerdictSource, string> = {
  model: "Veridict's analysis, verified and scored against the transcript",
  replayed: "Example: a stored assessment from an earlier run, replayed without a new analysis",
  fixture: "Demo: a prepared example assessment for synthetic testimony. Not produced by a model",
};

// Pages as "28" or "28–29" runs, in order.
export function pageRuns(pages: readonly number[]) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return runs.join(", ");
}

// What a session's coverage means, in sentences a reviewer can act on. Empty when code knows of nothing
// missing. Skipped line numbers alone aren't listed here: they are often blank lines.
export function coverageNotes(c: Pick<SessionCoverage, "blankPages" | "unreadPages" | "gaps">): string[] {
  const notes: string[] = [];
  if (c.blankPages.length) notes.push(`PDF ${c.blankPages.length === 1 ? "page" : "pages"} ${pageRuns(c.blankPages)} ${c.blankPages.length === 1 ? "has" : "have"} no text, so nothing on ${c.blankPages.length === 1 ? "it" : "them"} was checked.`);
  if (c.unreadPages.length) notes.push(`PDF ${c.unreadPages.length === 1 ? "page" : "pages"} ${pageRuns(c.unreadPages)} couldn't be read, so ${c.unreadPages.length === 1 ? "it was" : "they were"} not checked.`);
  for (const g of c.gaps) notes.push(`Transcript ${g.missingPages.length === 1 ? "page" : "pages"} ${pageRuns(g.missingPages)} ${g.missingPages.length === 1 ? "is" : "are"} missing, between ${g.after} and ${g.before}.`);
  return notes;
}
