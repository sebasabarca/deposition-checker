// How solid the evidence behind a cross-witness finding is, on a fixed five-point checklist, and its
// review priority. Pure. Like evidence-strength-v1 the score measures the evidence, not which witness
// is right, and only orders findings within a priority. What changes across witnesses: a conflict
// between two first-hand accounts weighs more than one resting on what someone was told.

import type { CrossFinding } from "../adjudicate/discoverCrossSchema";
import type { DirectSide, Lane } from "../verify/direct";
import type { EvidenceStrength, Priority, StrengthCheck } from "./evidenceStrength";

export const EVIDENCE_STRENGTH_CROSS_VERSION = "evidence-strength-cross-v1";
const HIGH_FROM = 80;
const MEDIUM_FROM = 50;

export type CrossStrengthInput = { classification: CrossFinding["classification"]; lane: Lane; a: DirectSide; b: DirectSide; basisA: CrossFinding["basis_a"]; basisB: CrossFinding["basis_b"] };

const OWN_WORDS = new Set(["witness", "adopted"]);
const clearAssertion = (s: DirectSide) => s.level === "clear" && !s.noRecall && !s.reportedSpeech;
// First-hand only when the model says so and code finds no reported speech in the witness's words.
const firstHand = (s: DirectSide, basis: CrossFinding["basis_a"]) => basis === "personal_observation" && !s.reportedSpeech;
const check = (label: string, points: number, max: number, origin: StrengthCheck["origin"], detail: string): StrengthCheck => ({ component: "E", label, points, max, origin, detail });

export function crossPriorityOf({ classification, lane, a, b, basisA, basisB }: CrossStrengthInput): { priority: Priority; priorityReason: string } {
  if (lane === "unverified") return { priority: "unverified", priorityReason: "A mandatory source check failed." };
  if (lane === "needs_context") return { priority: "needs_context", priorityReason: "Missing context or unresolved attribution." };
  if (lane === "compatible") return { priority: "low", priorityReason: "Not established as conflicting." };
  if (classification !== "direct_conflict") return { priority: "medium", priorityReason: "The conflict depends on context." };
  if (!firstHand(a, basisA) || !firstHand(b, basisB)) return { priority: "medium", priorityReason: "One account is second-hand." };
  if (![a, b].some(clearAssertion)) return { priority: "medium", priorityReason: "A direct conflict, but neither side is a plain assertion." };
  return { priority: "high", priorityReason: "Two first-hand accounts of the same thing that can't both be true." };
}

export function evidenceStrengthCross(input: CrossStrengthInput): EvidenceStrength {
  const { lane, a, b, basisA, basisB, classification } = input;
  const decided = crossPriorityOf(input);
  if (lane === "compatible") return { score: null, band: null, ...decided, checks: [], notScored: "Not applicable: this finding isn't a possible conflict." };
  const usable = lane !== "unverified" && [a, b].every((s) => s.resolved && OWN_WORDS.has(s.speaker) && ["exact", "fragments", "approximate"].includes(s.quote));
  if (!usable) return { score: null, band: null, ...decided, checks: [], notScored: "Not scored: the evidence needs review first." };
  const verbatim = (s: DirectSide) => s.quote === "exact" || s.quote === "fragments"; // word for word, whole or in ordered pieces
  const exact = verbatim(a) && verbatim(b);
  const clear = [a, b].filter(clearAssertion).length;
  const firsthand = [firstHand(a, basisA), firstHand(b, basisB)].filter(Boolean).length;
  const conflict = classification === "direct_conflict" ? 20 : classification === "possible_conflict_needs_context" ? 10 : 0;
  const checks = [
    check("Quotations match the transcript", exact ? 20 : 10, 20, "code", exact ? ([a, b].some((s) => s.quote === "fragments") ? "Both match word for word; at least one as ordered fragments, not one continuous passage." : "Both match exactly.") : "At least one only approximately matches."),
    check("Each statement is that witness's own", 20, 20, "code", "Both are the witnesses' own words, or plainly adopted."),
    check("Clear assertions", clear * 10, 20, "code", clear === 2 ? "Neither is hedged, unrecalled or reported speech." : `${2 - clear} of 2 is hedged, unrecalled or reported speech.`),
    check("First-hand accounts, according to Veridict's model and code", firsthand * 10, 20, "claude", firsthand === 2 ? "Both witnesses speak from what they saw or did." : `${2 - firsthand} of 2 rests on what someone was told, a belief, or is unclear.`),
    check("Conflict holds without missing context, according to Veridict's model", conflict, 20, "claude", conflict === 20 ? "A direct conflict." : conflict === 10 ? "A conflict that depends on context." : "No conflict established."),
  ];
  const score = checks.reduce((n, c) => n + c.points, 0);
  return { score, band: score >= HIGH_FROM ? "high" : score >= MEDIUM_FROM ? "medium" : "low", ...decided, checks, notScored: null };
}
