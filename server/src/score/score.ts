// The scoring engine (DESIGN.md, "Confidence scoring"). Claude classifies; this pure function turns
// its categorical observations, plus checks code performs itself, into a 0 to 100 assessment support
// score with the published rubric. No I/O, clock or randomness: the same input always gives the same
// Assessment, and every point in the total traces to a factor.
//
//   score = min(cap, A + C + S + K + U)
//
// The score says how strongly the evidence supports the classification Claude proposed. It is not a
// probability that the witness lied or that the classification is correct.

import type { TimeCheck } from "../ambiguity";
import type { Classification, Verdict } from "../adjudicate/schema";
import type { AttributionCheck, Level, SideAttribution } from "../verify/attribution";
import type { EvidenceStatus, SourceCheck } from "../verify/source";
import type { ContextCheck, CorroborationCheck } from "./checks";
import { RUBRIC_V1, type Rubric } from "./rubric";

export type Origin = "code" | "claude" | "code+claude";
export type Factor = { component: "A" | "C" | "S" | "K" | "U"; label: string; points: number; max: number; origin: Origin };
export type Cap = { rule: string; limit: number; reason: string; binding: boolean };
export type Band = "high" | "medium" | "low";
export type Priority = "high" | "medium" | "low" | "needs_context";

export type ScoringInput = {
  verdict: Verdict;
  source: SourceCheck;
  attribution: AttributionCheck;
  context: ContextCheck;
  corroboration: CorroborationCheck;
  timeCheck: TimeCheck | null;
  extractionDisagreement: boolean;
};

export type Assessment = {
  eligible: boolean;
  score: number | null;
  band: Band | null;
  // inconsistent_verdict: set before scoring, by adjudicate/consistency.ts; score() never returns it.
  unscoredReason: "evidence" | "insufficient_evidence" | "no_witness_assertion" | "inconsistent_verdict" | null;
  factors: Factor[];
  capsApplied: Cap[];
  notCorroborated: string[];
  reasons: string[]; // notes for the reviewer, such as "conflict needs inference; may be inferential"
  rubricVersion: string;
};

const ASSERTED: readonly Level[] = ["clear", "qualified"];
const WEAK: readonly Level[] = ["not_adopted", "no_recall"];
const CONFLICTS = ["explicit_negation", "value_conflict", "mutually_exclusive"];
const RECOLLECTION_REASONS = ["uncertain_recollection", "qualified_statement", "not_adopted_by_witness"];

export const toBand = (score: number, rubric: Rubric = RUBRIC_V1): Band =>
  score >= rubric.bands.high ? "high" : score >= rubric.bands.medium ? "medium" : "low";

function unscored(reason: Assessment["unscoredReason"], rubric: Rubric): Assessment {
  return { eligible: false, score: null, band: null, unscoredReason: reason, factors: [], capsApplied: [], notCorroborated: [], reasons: [], rubricVersion: rubric.version };
}

function attributionFactors(side: "A" | "B", s: SideAttribution, exact: boolean, falsePositive: boolean, r: Rubric): Factor[] {
  const exactFactor: Factor = { component: "A", label: `Side ${side}: key phrase matches exactly`, points: exact ? r.exactMatch : 0, max: r.exactMatch, origin: "code" };
  if (falsePositive) {
    return [
      exactFactor,
      {
        component: "A",
        label: `Side ${side}: code ${s.claudeContradicted ? "contradicts" : "agrees with"} the analysis's attribution`,
        points: s.claudeContradicted ? 0 : r.falsePositiveAttribution,
        max: r.falsePositiveAttribution,
        origin: "code+claude",
      },
    ];
  }
  const points = s.level === "clear" ? r.attribution.clear : s.level === "qualified" ? r.attribution.qualified : 0;
  return [exactFactor, { component: "A", label: `Side ${side}: attribution ${s.level}`, points, max: r.attribution.clear, origin: "code+claude" }];
}

function semanticFactors(v: Verdict, packetIds: readonly string[], r: Rubric, reasons: string[]): Factor[] {
  const f = (label: string, points: number, max: number): Factor => ({ component: "S", label, points, max, origin: "claude" });
  if (v.classification === "direct") {
    const d = r.direct;
    const basis = CONFLICTS.includes(v.conflictBasis);
    if (v.conflictBasis === "requires_inference") reasons.push("conflict needs inference; may be inferential");
    return [
      f(`Same event: ${v.sameEvent}`, v.sameEvent === "yes" ? d.sameEventYes : v.sameEvent === "uncertain" ? d.sameEventUncertain : 0, d.sameEventYes),
      f(`Conflict basis: ${v.conflictBasis}`, basis ? d.conflictBasis : 0, d.conflictBasis),
      f(`Scope aligned: ${v.scopeAligned}`, v.scopeAligned === "yes" ? d.scopeYes : v.scopeAligned === "uncertain" ? d.scopeUncertain : 0, d.scopeYes),
    ];
  }
  if (v.classification === "inferential") {
    const i = r.inferential;
    const supported =
      v.inferenceSteps.length > 0 && v.inferenceSteps.every((s) => s.supportingIds.length > 0 && s.supportingIds.every((id) => packetIds.includes(id)));
    const n = v.unestablishedAssumptions.length;
    return [
      f(`Same event: ${v.sameEvent}`, v.sameEvent === "yes" ? i.sameEventYes : v.sameEvent === "uncertain" ? i.sameEventUncertain : 0, i.sameEventYes),
      f(`Inference steps cite the packet (${v.inferenceSteps.length} steps)`, supported ? i.supportedSteps : 0, i.supportedSteps),
      f(`Unestablished assumptions: ${n}`, i.assumptions[Math.min(n, i.assumptions.length - 1)], i.assumptions[0]),
    ];
  }
  // false_positive
  const p = r.falsePositive;
  const reason = v.falsePositiveReason;
  const consistent = reason !== null && (reason === "different_event" ? v.sameEvent === "no" : v.sameEvent !== "no");
  return [
    f(`False-positive reason: ${reason ?? "none"}`, reason !== null ? p.reasonGiven : 0, p.reasonGiven),
    f(`Reason consistent with same event: ${v.sameEvent}`, consistent ? p.reasonConsistent : 0, p.reasonConsistent),
  ];
}

// The class-specific code checks; each found one earns 5, up to 15. Absence scores 0 and is listed,
// never a penalty.
function corroborationChecks(input: ScoringInput): [string, boolean][] {
  const { verdict: v, corroboration: k, timeCheck: t, attribution: at } = input;
  const sides = [at.a, at.b];
  if (v.classification === "direct") {
    return [
      ["Negation asymmetry on a shared term", k.negationAsymmetry],
      ["Conflicting numbers, dates or times", k.conflictingValues],
      ["Specific anchor in both", k.sharedAnchor],
    ];
  }
  if (v.classification === "inferential") {
    return [
      ["Specific anchor in both", k.sharedAnchor],
      ["Times incompatible", t?.status === "incompatible"],
      ["Date or sequence conflict", k.dateConflict],
    ];
  }
  return [
    ["Times compatible", t?.status === "compatible"],
    ["Qualifier or approximation word on a side", sides.some((s) => s.qualifier !== null || s.approximation)],
    ["No-recall answer on a side", sides.some((s) => s.noRecall)],
    ["Key phrase only in an attorney's words", sides.some((s) => s.location === "attorney_or_colloquy")],
    ["Different dates on each side", k.dateConflict],
  ];
}

export function score(input: ScoringInput, rubric: Rubric = RUBRIC_V1): Assessment {
  const { verdict: v, source, attribution: at } = input;
  const c: Classification = v.classification;
  const conflict = c === "direct" || c === "inferential";
  if (source.status === "wrong_reference" || source.status === "unsupported") return unscored("evidence", rubric);
  if (c === "insufficient_evidence") return unscored("insufficient_evidence", rubric);
  if (conflict && !ASSERTED.includes(at.a.level) && !ASSERTED.includes(at.b.level)) return unscored("no_witness_assertion", rubric);

  const reasons: string[] = [];
  const factors: Factor[] = [
    ...attributionFactors("A", at.a, source.a.matchScore >= 1, !conflict, rubric),
    ...attributionFactors("B", at.b, source.b.matchScore >= 1, !conflict, rubric),
    { component: "C", label: `Code: ${input.context.detail}`, points: input.context.wholeExchanges ? rubric.wholeExchanges : 0, max: rubric.wholeExchanges, origin: "code" },
    { component: "C", label: `Analysis: ${v.needsMoreContext ? "needs more context" : "no more context needed"}`, points: v.needsMoreContext ? 0 : rubric.noMoreContextNeeded, max: rubric.noMoreContextNeeded, origin: "claude" },
    ...semanticFactors(v, source.packetIds, rubric, reasons),
  ];

  const notCorroborated: string[] = [];
  let corroboration = 0;
  for (const [label, found] of corroborationChecks(input)) {
    if (!found) {
      notCorroborated.push(label);
      continue;
    }
    const points = Math.min(rubric.corroborationEach, rubric.corroborationMax - corroboration);
    corroboration += points;
    factors.push({ component: "K", label, points, max: rubric.corroborationEach, origin: "code" });
  }

  // U: a full allowance, minus a named deduction for each reason for doubt, floored at 0.
  let allowance = rubric.uncertainty;
  factors.push({ component: "U", label: "Uncertainty allowance", points: allowance, max: rubric.uncertainty, origin: "code" });
  const deduct = (label: string, amount: number, origin: Origin) => {
    const points = -Math.min(amount, allowance);
    allowance += points;
    factors.push({ component: "U", label, points, max: 0, origin });
  };
  if (v.alternativeExplanation?.trim()) deduct(conflict ? "The analysis gave an alternative explanation" : "The analysis gave an alternative: it may be a real conflict", rubric.alternativeExplanation, "claude");
  if (conflict) {
    if (at.a.approximation) deduct("Side A: approximation word", rubric.approximationPerSide, "code");
    if (at.b.approximation) deduct("Side B: approximation word", rubric.approximationPerSide, "code");
  }
  if (input.extractionDisagreement) deduct("Path A's epistemic tag disagrees with the analysis's attribution", rubric.extractionDisagreement, "code+claude");

  const sum = factors.reduce((t, f) => t + f.points, 0);

  const caps: Omit<Cap, "binding">[] = [];
  const timing = v.aboutTimingOfSameEvent ? input.timeCheck?.status : undefined;
  if (conflict) {
    const levels = [at.a.level, at.b.level];
    if (levels.some((l) => WEAK.includes(l))) caps.push({ rule: "side_not_adopted_or_no_recall", limit: rubric.caps.notAdopted, reason: "a side is not an adopted witness assertion, or the witness doesn't recall" });
    if (levels.some((l) => l === "qualified" || l === "uncertain")) caps.push({ rule: "side_qualified_or_uncertain", limit: rubric.caps.qualified, reason: "a side is qualified, ambiguous or a nonresponsive answer" });
    if (v.sameEvent === "no") caps.push({ rule: "same_event_no", limit: rubric.caps.notSameEvent, reason: "The analysis's classification contradicts its own same-event observation" });
    if (timing === "compatible") caps.push({ rule: "times_compatible", limit: rubric.caps.compatibleTimes, reason: "the times overlap within tolerance" });
  } else {
    if (timing === "incompatible") caps.push({ rule: "times_incompatible", limit: rubric.caps.incompatibleTimes, reason: "the times differ beyond tolerance, so this may be real" });
    if (v.falsePositiveReason && RECOLLECTION_REASONS.includes(v.falsePositiveReason) && at.a.level === "clear" && at.b.level === "clear") {
      caps.push({ rule: "reason_not_supported_by_attribution", limit: rubric.caps.unsupportedReason, reason: "both sides are clear assertions, so the stated reason isn't supported" });
    }
  }
  const lowest = Math.min(100, ...caps.map((x) => x.limit));
  const total = Math.max(0, Math.min(lowest, sum));
  const capsApplied = caps.map((x) => ({ ...x, binding: x.limit === lowest && x.limit < sum }));

  return { eligible: true, score: total, band: toBand(total, rubric), unscoredReason: null, factors, capsApplied, notCorroborated, reasons, rubricVersion: rubric.version };
}

// Review priority (DESIGN.md, "Review priority"), computed separately from the score. Mandatory
// context review is for cases where missing context prevents a defensible assessment. A valid false
// positive keeps its score-based priority even when Claude asks for more context (approved October
// 29); that request is recorded on the finding as context_requested instead.
export function prioritize(classification: Classification, evidenceStatus: EvidenceStatus, assessment: Assessment, reviewState = "unreviewed", needsMoreContext = false): Priority {
  if (evidenceStatus === "wrong_reference" || evidenceStatus === "unsupported") return "low";
  if (
    classification === "insufficient_evidence" ||
    assessment.unscoredReason !== null ||
    (needsMoreContext && classification !== "false_positive") ||
    assessment.capsApplied.some((x) => x.rule === "same_event_no") ||
    reviewState === "needs_more_context"
  ) {
    return "needs_context";
  }
  const band = assessment.band!;
  if (classification === "direct") return band === "high" ? "high" : "medium";
  if (classification === "inferential") return band === "high" ? "high" : band === "medium" ? "medium" : "low";
  return band === "low" ? "medium" : "low";
}
