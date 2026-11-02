// Semantic consistency of a verdict's own fields (approved October 29). Pure: no I/O. A verdict
// can pass the strict schema and still contradict itself, such as a false positive that names a
// conflict basis. Such a verdict is kept as received, with its issues, and its finding is unscored
// for review: it is never converted to another classification, never retried automatically, and
// never taken as evidence of a contradiction either way.
//
// Only categorical fields are compared. The free-text explanation isn't parsed, so a disagreement
// between it and the classification is left to the reviewer.
//
// Grounding (adjudicate-v3, plus one check for every version): code can check the structure of the
// claim that a conflict rests on the two cited exchanges (the model's conflictSource, that every
// context line it says it used was actually shown as context, and that an inference cites both
// exchanges), but not its truth: a model that misreports what it relied on passes. Layer 1 already
// requires both key phrases to be found in their cited exchanges.
//
// Not included: direct with sameEvent "no". DESIGN.md's rubric already handles it (cap 25, priority
// needs_context, case 13), and rubric v1 is frozen.

import type { Packet } from "./packet";
import type { Verdict } from "./schema";

export const CONSISTENCY_ISSUES = {
  false_positive_with_conflict_basis: "a false positive names a conflict basis",
  conflict_without_basis: "a direct or inferential verdict names no conflict basis",
  false_positive_without_reason: "a false positive gives no false-positive reason",
  reason_without_false_positive: "a false-positive reason on a verdict that isn't a false positive",
  different_event_without_different_events: 'different_event with sameEvent other than "no"',
  inferential_without_steps: "an inferential verdict with no inference steps",
  alternative_support_mismatch: "alternativeSupport and alternativeExplanation disagree on whether there is an alternative",
  established_alternative: "the alternative explanation is marked established, which contradicts the classification",
  inference_step_unverified_evidence: "an inference step cites no evidence, or an exchange ID that isn't in the packet",
  inference_not_grounded_in_both: "the inference steps, taken together, don't cite both exchanges",
  conflict_not_grounded: "a direct or inferential verdict whose conflict, by its own account, isn't from the two cited exchanges",
  conflict_source_without_conflict: "a verdict with no conflict says its conflict comes from the cited exchanges",
  context_reference_not_in_packet: "a context line the model says it used wasn't shown as context",
  unresolved_detail_difference: "a false positive about the same event that lists a detail as different",
} as const;
export type ConsistencyIssue = keyof typeof CONSISTENCY_ISSUES;

type Shown = Pick<Packet, "a" | "b">;

// A page:line or a range ("40:03", "40:2-40:03") resolves when it starts and ends on lines shown with
// one side, and covers at least one of that side's context lines (not only the exchange's own lines).
export function resolvesToContext(lines: string, packet: Shown): boolean {
  const m = lines.trim().match(/^(\d+):(\d+)(?:\s*[-–]\s*(?:(\d+):)?(\d+))?$/);
  if (!m) return false;
  const start = { page: Number(m[1]), line: Number(m[2]) };
  const end = m[4] ? { page: Number(m[3] ?? m[1]), line: Number(m[4]) } : start;
  const key = (p: { page: number; line: number }) => p.page * 1000 + p.line;
  return [packet.a, packet.b].some((side) => {
    const all = [...side.before, ...side.lines, ...side.after];
    const shown = new Set(all.map((l) => key(l)));
    if (!shown.has(key(start)) || !shown.has(key(end)) || key(end) < key(start)) return false;
    return [...side.before, ...side.after].some((l) => key(l) >= key(start) && key(l) <= key(end));
  });
}

export function checkConsistency(v: Verdict, packet?: Shown): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const conflict = v.classification === "direct" || v.classification === "inferential";
  const falsePositive = v.classification === "false_positive";
  if (falsePositive && v.conflictBasis !== "none") issues.push("false_positive_with_conflict_basis");
  if (conflict && v.conflictBasis === "none") issues.push("conflict_without_basis");
  if (falsePositive && v.falsePositiveReason === null) issues.push("false_positive_without_reason");
  if (!falsePositive && v.falsePositiveReason !== null) issues.push("reason_without_false_positive");
  if (v.falsePositiveReason === "different_event" && v.sameEvent !== "no") issues.push("different_event_without_different_events");
  if (v.classification === "inferential" && v.inferenceSteps.length === 0) issues.push("inferential_without_steps");
  // adjudicate-v2 fields: absent (undefined) on v1 verdicts, which aren't checked for them.
  if (v.alternativeSupport !== undefined) {
    const hasAlternative = v.alternativeExplanation !== null && v.alternativeExplanation.trim() !== "";
    if (hasAlternative !== (v.alternativeSupport !== null)) issues.push("alternative_support_mismatch");
    if (v.alternativeSupport === "established" && (conflict || falsePositive)) issues.push("established_alternative");
  }
  // Each step must cite real evidence, but a step needn't cite both exchanges: the chain as a whole
  // must connect them. An unknown ID is an unverified citation, so the verdict isn't scored.
  if (packet && v.classification === "inferential" && v.inferenceSteps.length > 0) {
    const valid = new Set([packet.a.id, packet.b.id]);
    if (v.inferenceSteps.some((s) => s.supportingIds.length === 0 || s.supportingIds.some((id) => !valid.has(id)))) issues.push("inference_step_unverified_evidence");
    const cited = new Set(v.inferenceSteps.flatMap((s) => s.supportingIds));
    if (!cited.has(packet.a.id) || !cited.has(packet.b.id)) issues.push("inference_not_grounded_in_both");
  }
  // adjudicate-v3 fields.
  if (v.conflictSource !== undefined) {
    if (conflict && v.conflictSource !== "cited_exchanges") issues.push("conflict_not_grounded");
    if (!conflict && v.conflictSource === "cited_exchanges") issues.push("conflict_source_without_conflict");
  }
  if (packet && v.contextUsed?.some((c) => !resolvesToContext(c.lines, packet))) issues.push("context_reference_not_in_packet");
  // adjudicate-v4: a listed difference can't be dismissed as compatible without a person seeing it.
  if (falsePositive && v.sameEvent !== "no" && v.detailsCompared?.some((d) => d.relation === "different")) issues.push("unresolved_detail_difference");
  return issues;
}
