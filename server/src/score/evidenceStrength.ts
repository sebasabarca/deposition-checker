// How solid the evidence behind a direct finding is, on a fixed five-point checklist, and its review
// priority. Pure: no I/O and no model call, so any stored finding can be scored again. The score
// measures the evidence, not the chance that the witness contradicted themselves, so it decides
// neither lane nor priority, and only orders findings within a priority. Priority comes from the
// lane, the model's classification and code's checks, in that order.

import type { DirectSide, Lane } from "../verify/direct";

export const EVIDENCE_STRENGTH_VERSION = "evidence-strength-v1";
export const HIGH_FROM = 80; // bands describe the score; they don't set priority
export const MEDIUM_FROM = 50;

export type StrengthCheck = { component: "E"; label: string; points: number; max: number; origin: "code" | "claude"; detail: string };
export type StrengthInput = { classification: string; comparable: string; lane: Lane; a: DirectSide; b: DirectSide };
export type EvidenceStrength = { score: number | null; band: "high" | "medium" | "low" | null; priority: Priority; priorityReason: string; checks: StrengthCheck[]; notScored: string | null };
export type Priority = "high" | "medium" | "low" | "needs_context" | "unverified";

const OWN_WORDS = new Set(["witness", "adopted"]);
const clearAssertion = (s: DirectSide) => s.level === "clear" && !s.noRecall && !s.reportedSpeech;
const bandOf = (score: number) => (score >= HIGH_FROM ? "high" : score >= MEDIUM_FROM ? "medium" : "low");
const check = (label: string, points: number, max: number, origin: StrengthCheck["origin"], detail: string): StrengthCheck => ({ component: "E", label, points, max, origin, detail });

function checklist({ classification, comparable, a, b }: StrengthInput): StrengthCheck[] {
  const exact = a.quote === "exact" && b.quote === "exact";
  const clear = [a, b].filter(clearAssertion).length;
  const conflict = classification === "direct_contradiction" ? 20 : classification === "inferential_contradiction" ? 10 : 0;
  return [
    check("Quotations match the transcript", exact ? 20 : 10, 20, "code", exact ? "Both match exactly." : "At least one only approximately matches."),
    check("The statements are the witness's", 20, 20, "code", "Both are the witness's own words, or plainly adopted."),
    check("Clear assertions", clear * 10, 20, "code", clear === 2 ? "Neither is hedged, unrecalled or secondhand." : `${2 - clear} of 2 is hedged, unrecalled or secondhand.`),
    check("Same subject, according to the model", comparable === "yes" ? 20 : 0, 20, "claude", comparable === "yes" ? "The model says both concern the same thing." : "The model wasn't sure they concern the same thing."),
    check("Conflict holds without missing context, according to the model", conflict, 20, "claude", conflict === 20 ? "A direct conflict." : conflict === 10 ? "A conflict only through an inference." : "No conflict established without more context."),
  ];
}

// In order: failed verification, then missing context, then compatible, then direct, then inferential.
// High needs a direct conflict on one subject with at least one plain assertion: one hedge doesn't undo
// a conflict ("I think I went out" against "I was home all evening"), but two leave it softer.
export function priorityOf({ classification, comparable, lane, a, b }: StrengthInput): { priority: Priority; priorityReason: string } {
  if (lane === "unverified") return { priority: "unverified", priorityReason: "A mandatory source check failed." };
  if (lane === "needs_context") return { priority: "needs_context", priorityReason: "Missing context or unresolved attribution." };
  if (lane === "compatible") return { priority: "low", priorityReason: "Not established as conflicting." };
  if (classification !== "direct_contradiction") return { priority: "medium", priorityReason: "The conflict depends on an inference." };
  if (comparable !== "yes") return { priority: "medium", priorityReason: "The model wasn't sure the passages concern the same thing." };
  if (![a, b].some(clearAssertion)) return { priority: "medium", priorityReason: "A direct conflict, but neither side is a plain assertion." };
  return { priority: "high", priorityReason: "A direct conflict on one subject, with at least one plain assertion." };
}

export function evidenceStrength(input: StrengthInput): EvidenceStrength {
  const { lane, a, b } = input;
  const decided = priorityOf(input);
  // A compatible finding's evidence can be solid without any conflict, so a number would mislead.
  if (lane === "compatible") return { score: null, band: null, ...decided, checks: [], notScored: "Not applicable: this finding isn't a possible conflict." };
  const usable = lane !== "unverified" && [a, b].every((s) => s.resolved && OWN_WORDS.has(s.speaker) && (s.quote === "exact" || s.quote === "approximate"));
  if (!usable) return { score: null, band: null, ...decided, checks: [], notScored: "Not scored: the evidence needs review first." };
  const checks = checklist(input);
  const score = checks.reduce((total, c) => total + c.points, 0);
  return { score, band: bandOf(score), ...decided, checks, notScored: null };
}

// Why a direct finding has no score, or null when it has one. A compatible finding keeps its own reason.
export function unscoredReasonOf(lane: Lane, evidenceStatus: string, score: number | null): string | null {
  if (lane === "unverified") return ["wrong_reference", "unsupported"].includes(evidenceStatus) ? "evidence" : "attribution_failed";
  if (lane === "compatible") return "direct_discovery";
  return score === null ? "needs_context" : null;
}
