// Deterministic safeguards on a model's conflict verdict (direct or inferential). Pure: no I/O.
//
// Each rule reads only what code can establish from the stored lines or the verdict's own words, and none of them
// deletes anything: a finding that trips one is published as "needs context" (the classification a model's own
// needs_more_context answer gets), with the model's outcome, explanation and alternative kept and every rule that
// fired recorded. A real contradiction that trips a rule stays in front of the lawyer, in the review lane, never as
// an unqualified contradiction.
//
//   examiner_words   a side's key phrase is the examiner's words, not plainly adopted by the witness (verify/
//                    attribution.ts location attorney_or_colloquy, or question_other: the phrase is in the question and
//                    the answer is not a plain yes or no). A plain yes/no to the question is adoption and does not trip it.
//   not_own_knowledge a side is the witness relaying someone else's words, or a hypothetical (the model's own
//                    attribution reported_by_other / hypothetical / attorney_statement): not the witness's knowledge.
//   no_recall        a side is a no-recall answer (code's reading of the stored answer, or the model's
//                    does_not_recall), or the cited answer contains a no-recall clause ("I don't recall seeing Faye,
//                    but no"): not recalling is not a denial, and a mixed answer needs a person to read it.
//   says_compatible  the verdict's own explanation says both statements can be true or are not clearly inconsistent.
//   established_alternative the verdict rates its own alternative (compatible) explanation as established.

import type { SideAttribution } from "./attribution";

export const SAFEGUARDS_VERSION = "safeguards-v1";
export type SafeguardRule = "examiner_words" | "not_own_knowledge" | "no_recall" | "says_compatible" | "established_alternative";
export type Safeguard = { rule: SafeguardRule; side: "a" | "b" | null; detail: string };

type VerdictFields = {
  outcome: string;
  attributionA: string;
  attributionB: string;
  explanation: string;
  alternativeSupport: string | null;
};

const CONFLICT = new Set(["direct", "inferential"]);
const NOT_OWN = new Set(["reported_by_other", "hypothetical", "attorney_statement"]);
// Narrower than verify/packet.ts SAYS_COMPATIBLE (a review flag): only wording that concedes the pair can stand
// together. "cannot both be true" and "not compatible" never match (no space after "can"; no bare "compatible").
const CONCEDES = /\b(?:both (?:statements |accounts |answers |passages |versions )?(?:can|could|may|might) (?:both )?be (?:true|accurate|correct)|(?:can|could|may|might) both be (?:true|accurate|correct)|not (?:clearly |necessarily |directly )?(?:inconsistent|contradictory|in conflict))\b/i;

const NO_RECALL_CLAUSE = /\b(?:i )?(?:do not|don't|did not|didn't|cannot|can't|could not|couldn't) (?:recall|remember)\b|\bno (?:recollection|memory)\b|\bnot that i (?:recall|remember)\b/i;

// answers: each side's cited answer as stored (verify/source.ts answerText), when known.
export function safeguardsFor(v: VerdictFields, attribution: { a: SideAttribution | null; b: SideAttribution | null } | null, answers?: { a: string; b: string }): Safeguard[] {
  if (!CONFLICT.has(v.outcome)) return [];
  const out: Safeguard[] = [];
  for (const side of ["a", "b"] as const) {
    const att = attribution?.[side] ?? null;
    const claude = side === "a" ? v.attributionA : v.attributionB;
    if (att?.location === "attorney_or_colloquy") out.push({ rule: "examiner_words", side, detail: "the quoted words are only in the examiner's words or colloquy" });
    else if (att?.location === "question_other") out.push({ rule: "examiner_words", side, detail: "the quoted words are the examiner's question, and the answer is not a plain yes or no" });
    if (NOT_OWN.has(claude)) out.push({ rule: "not_own_knowledge", side, detail: `Veridict's model reads this side as ${claude.replace(/_/g, " ")}` });
    const clause = answers?.[side].match(NO_RECALL_CLAUSE)?.[0];
    if (att?.noRecall || claude === "does_not_recall" || clause) out.push({ rule: "no_recall", side, detail: att?.noRecall ? "the stored answer is a no-recall answer" : clause ? `the cited answer says "${clause}"` : "Veridict's model reads this side as not recalling" });
  }
  const m = v.explanation.match(CONCEDES);
  if (m) out.push({ rule: "says_compatible", side: null, detail: `the explanation says "${m[0]}"` });
  if (v.alternativeSupport === "established") out.push({ rule: "established_alternative", side: null, detail: "the verdict rates its own alternative explanation as established" });
  return out;
}
