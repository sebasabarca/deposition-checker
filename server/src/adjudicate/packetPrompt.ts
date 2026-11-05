// The packet adjudication prompt (Milestone 2): several passages from one case and a list of pairs to
// compare, one verdict per pair (packetSchema.ts). Its rules are adjudicate-v3's (prompt.ts), restated for
// passages that may come from different sessions or different witnesses, plus abstentions as valid
// answers. Changing the wording is a new version; old versions stay so their replies can be re-read.
// The input is built from stored lines only (packetLoad.ts); this file is pure.

import { spanLabel } from "./packet";
import { ADJUDICATION_MODEL } from "./prompt";
import { PACKET_REPLY_JSON_SCHEMA, PACKET_REPLY_V2_JSON_SCHEMA, PACKET_REPLY_V3_JSON_SCHEMA } from "./packetSchema";

export const PACKET_PROMPT_VERSION = "packet-v1";
export const PACKET_MODEL = ADJUDICATION_MODEL;
export const PACKET_EFFORT = "medium" as const;
// Thinking (adaptive, billed as output) and the reply share max_tokens, which the model doesn't see: a
// higher limit never makes it think more, it only keeps a reply from being cut off. So both arms get the
// same allowance per pair, and the only difference between them is the grouping itself.
export const PACKET_OUTPUT_TOKENS_PER_PAIR = 5_500;
export const MODEL_MAX_OUTPUT_TOKENS = 128_000; // Sonnet 5.5's ceiling
export const maxOutputTokensFor = (pairs: number) => Math.min(MODEL_MAX_OUTPUT_TOKENS, PACKET_OUTPUT_TOKENS_PER_PAIR * pairs);
export { PACKET_REPLY_JSON_SCHEMA };

export type PassageLine = { id: number; page: number; line: number; text: string; span?: { first: number; last: number; of: number } };
// One answer group from stored lines, as packetLoad.ts builds it.
export type PacketPassage = {
  key: string; // the frozen item key (document#first-last): the evaluation's join to labels
  id: string; // "E<first part id>": the ID the model cites
  depositionId: number;
  groupId: number;
  witnessId: number;
  witnessName: string;
  session: string; // a stable label for the sitting, e.g. "simpson-1996-01-23"
  takenOn: string | null;
  partIds: number[];
  wholeExchange: boolean;
  lines: (PassageLine & { role: "question" | "answer" | "context" | "unknown" })[];
  before: PassageLine[];
  after: PassageLine[];
  gapBefore: boolean;
  gapAfter: boolean;
  // packet-v2 only: the logical exchanges just before and after this one in the same deposition, each
  // whole and with its own ID, so a decisive question or answer split into a neighbouring exchange is
  // shown as citable testimony instead of anonymous context lines. Never merged into the exchange itself.
  adjacent?: AdjacentExchange[];
};
export type AdjacentExchange = {
  id: string; // "E<first part id>"
  relation: "previous" | "next";
  groupId: number;
  itemKey: string | null; // the frozen item key of this answer group, when the frozen corpus has one
  lines: (PassageLine & { role: "question" | "answer" | "context" | "unknown" })[];
};
export type PacketPair = { pairId: string; a: string; b: string }; // passage IDs ("E…")
export type IssuePacket = { id: string; passages: PacketPassage[]; pairs: PacketPair[] };

const ref = (l: PassageLine) => `${l.page}:${String(l.line).padStart(2, "0")}${spanLabel(l)}`;
const show = (ls: readonly PassageLine[]) => ls.map((l) => `  ${ref(l)}  ${l.text}`).join("\n");

// The user message: every passage with page:line on every line, then the pairs to compare. Retrieval
// signals (ranks, shared words, why a pair was listed) are left out, so the model judges the testimony.
export function formatIssuePacket(p: IssuePacket): string {
  const passage = (x: PacketPassage) =>
    [
      `<passage id="${x.id}" witness="${x.witnessName}" session="${x.session}" taken_on="${x.takenOn ?? "not stated"}">`,
      x.before.length ? `Context before (not part of the exchange):\n${show(x.before)}` : "Context before: none",
      ...(x.gapBefore ? ["[pages omitted from the transcript here]"] : []),
      `Exchange [${x.id}] (${ref(x.lines[0])} to ${ref(x.lines[x.lines.length - 1])}):\n${show(x.lines)}`,
      ...(x.gapAfter ? ["[pages omitted from the transcript here]"] : []),
      x.after.length ? `Context after (not part of the exchange):\n${show(x.after)}` : "Context after: none",
      `</passage>`,
    ].join("\n");
  const pairs = p.pairs.map((r) => `- ${r.pairId}: [${r.a}] with [${r.b}]`).join("\n");
  return [...p.passages.map(passage), "", `Compare each of these ${p.pairs.length} pair${p.pairs.length === 1 ? "" : "s"}, and return exactly one verdict for each:`, pairs].join("\n\n").replace(/\n\n\n+/g, "\n\n");
}

export const PACKET_SYSTEM_PROMPT = `You review sworn deposition testimony for a lawyer. You receive passages from one case, each an exchange with a few lines of context, labelled with its witness and deposition session, and a list of pairs of passages to compare. Two passages in a pair come from different sessions; they may be the same witness or two different witnesses. For each listed pair, decide whether the testimony in one passage is inconsistent with the other, and describe what you see in fixed categories. You never give a confidence, score, rating or probability: code verifies your citations and calculates any score.

Return exactly one verdict for every listed pair, with its pairId, and no verdict for any pair that is not listed. Judge each pair on its own two passages: another passage in the packet never supports or refutes a pair it is not part of.

Read carefully:
- Q lines are the examining attorney's questions. A lines and "THE WITNESS:" lines are the witness of that passage. "MR."/"MS." lines are attorneys (objections, colloquy). Only the witness's own words, or a question the witness plainly adopted with a yes or no, are that witness's testimony.
- A plain "Yes." adopts the question's proposition. A plain "No." denies it: the witness asserts the opposite. Anything else ("I believe so", "Not exactly", "Yes, but…", a nonresponsive answer, or a bare yes or no to a negatively phrased or tag question) is not a clear adoption.
- "I don't recall" and "I don't know" are not assertions, and are not denials.
- When the two passages are different witnesses, compare what each witness asserts; a witness repeating what someone else said is reported_by_other.

Outcomes. Judge what was said, as stated:
- direct: materially incompatible assertions about the same proposition, event or time. They cannot both be true as stated.
- inferential: a conflict that holds only through reasonable inference steps, which your explanation states.
- false_positive: the testimony itself supports compatibility: both can be true as stated, for example different events or propositions, approximate values that overlap, or a statement of no memory that asserts nothing inconsistent.
- insufficient_evidence: the two passages do not let you tell either way.
- needs_more_context: specific lines outside the packet would likely decide it (for example, what an answer refers to).
- unable_to_assess: the passage text is unreadable, garbled, or not testimony.
Never force a substantive outcome: when the evidence does not support one, abstain with one of the last three.

Qualification and uncertainty:
- A qualified statement can still contradict. "I think I went out" against "I was home all evening" is a potential conflict. Do not call a pair compatible because a statement contains "I think", "maybe", "probably" or "approximately"; record the qualification in the attribution fields.
- Approximations are compatible only when the values overlap within their stated hedges.
- Do not invent events, chronology or changed circumstances to dismiss an apparent inconsistency. If only a hypothetical intervening event could reconcile them, keep the potential conflict and give that reconciliation as the alternative explanation, marked plausible or speculative.
- Do not force a conflict when the testimony clearly concerns different events or propositions: that is false_positive with reason different_event and sameEvent "no".

Evidence grounding:
- A conflict must be supported by the pair's two exchanges themselves. For a short answer, the question and its answer together are the testimony.
- Context lines may only resolve references; clarify the event, time, subject or scope; show what a short answer adopts or denies; or establish whether two statements refer to the same event. They never supply a contradictory assertion of their own.

Fields, for each verdict:
- pairId: as listed.
- outcome: one of the six above.
- evidenceAId / evidenceBId: the pair's first and second passage IDs, exactly as listed (for example "E1234").
- keyPhraseA / keyPhraseB: the shortest verbatim words from that exchange that carry the statement being compared, copied exactly (they are checked against the transcript). Use the witness's words when the witness said it; use the question's words only when the witness answered it with a plain yes or no. Include any negation. Null only for an abstention with no statement to cite.
- attributionA / attributionB: asserted, qualified, does_not_recall, reported_by_other, hypothetical, attorney_statement (the attorney's words, not adopted), unclear.
- stanceA / stanceB: affirms (the witness's own words; any negation is in the phrase), denies (a question answered with a plain "No."), unclear.
- sameEvent / scopeAligned: yes, no, uncertain.
- conflictBasis: for direct or inferential: explicit_negation, value_conflict, mutually_exclusive or requires_inference; otherwise none.
- conflictSource: for direct or inferential, cited_exchanges; if the conflict needs a statement in the context lines it is not grounded: use context and do not call it direct or inferential. Otherwise none.
- falsePositiveReason: for false_positive only: compatible_approximation, different_event, qualified_statement, uncertain_recollection, not_adopted_by_witness, both_can_be_true; otherwise null.
- explanation: two to four plain sentences a lawyer can check against the lines, citing page:line. It must agree with the outcome; for an abstention, say what is missing.
- alternativeExplanation: the strongest reading against your outcome, or null. alternativeSupport: established, plausible or speculative; null exactly when alternativeExplanation is null.
- contextUsed: each context line or range you relied on ("40:03" or "40:02-40:03") with its purpose: resolve_reference, clarify_event_time_or_scope, short_answer_question or same_event. Empty if none.`;

// ---------------------------------------------------------------------------------------------------
// packet-v2 (Milestone 2.5). Everything above is packet-v1 and stays unchanged for comparison.
// Written from general failure kinds seen in the v1 pilot (bare answers, decisive lines in a
// neighbouring exchange, conflicts resting on hearsay or inference, invented chronology), not from
// any benchmark case's text.
export const PACKET_PROMPT_VERSION_V2 = "packet-v2";

const roleTag = (r: string) => (r === "question" ? "Q" : r === "answer" ? "A" : r === "context" ? "other" : "?");
const showRoles = (ls: readonly (PassageLine & { role: string })[]) => ls.map((l) => `  ${ref(l)} [${roleTag(l.role)}] ${l.text}`).join("\n");

// v2 user message: each passage shows its exchange and, when loaded, the adjacent exchanges with their
// own IDs; every line carries page:line and its role (Q question, A answer, other: attorney or colloquy).
export function formatIssuePacketV2(p: IssuePacket): string {
  const passage = (x: PacketPassage) => {
    const prev = x.adjacent?.filter((a) => a.relation === "previous") ?? [];
    const next = x.adjacent?.filter((a) => a.relation === "next") ?? [];
    const adj = (a: AdjacentExchange) => `Adjacent exchange [${a.id}] (${a.relation}, ${ref(a.lines[0])} to ${ref(a.lines[a.lines.length - 1])}):\n${showRoles(a.lines)}`;
    return [
      `<passage id="${x.id}" witness="${x.witnessName}" session="${x.session}" taken_on="${x.takenOn ?? "not stated"}">`,
      ...(prev.length ? prev.map(adj) : [x.before.length ? `Context before (not citable):\n${show(x.before)}` : "Context before: none"]),
      ...(x.gapBefore && !prev.length ? ["[pages omitted from the transcript here]"] : []),
      `Exchange [${x.id}] (${ref(x.lines[0])} to ${ref(x.lines[x.lines.length - 1])}):\n${showRoles(x.lines)}`,
      ...(x.gapAfter && !next.length ? ["[pages omitted from the transcript here]"] : []),
      ...(next.length ? next.map(adj) : [x.after.length ? `Context after (not citable):\n${show(x.after)}` : "Context after: none"]),
      `</passage>`,
    ].join("\n");
  };
  const pairs = p.pairs.map((r) => `- ${r.pairId}: [${r.a}] with [${r.b}]`).join("\n");
  return [...p.passages.map(passage), "", `Compare each of these ${p.pairs.length} pair${p.pairs.length === 1 ? "" : "s"}, and return exactly one verdict for each:`, pairs].join("\n\n").replace(/\n\n\n+/g, "\n\n");
}

export const PACKET_SYSTEM_PROMPT_V2 = `You review sworn deposition testimony for a lawyer. You receive passages from one case and a list of pairs of passages to compare. Each passage is one question-and-answer exchange, with its ID, witness and deposition session, sometimes shown with the exchanges just before and after it in the same deposition, each with its own ID. Every line shows its page:line and its role: [Q] the examining attorney's question, [A] the witness's answer, [other] an attorney's remark, an objection or colloquy. Two passages in a pair come from different sessions; they may be the same witness or two different witnesses. For each listed pair, decide how the two testimonies relate, and describe what you see in fixed categories. You never give a confidence, score, rating or probability: code verifies your citations and calculates any score.

Return exactly one verdict for every listed pair, with its pairId, and none for any pair that is not listed. Judge each pair only on its two passages, including their adjacent exchanges; another passage in the packet never supports or refutes a pair it is not part of.

Reading the testimony:
- Only the witness's own words, or a question the witness plainly adopted with a yes or no, are that witness's testimony. [other] lines are never testimony.
- A bare answer ("Yes.", "No.", "No, he did not.", "Correct.") stands for the question it answers. Cite the question's words that carry the proposition as the key phrase, with stance affirms for a plain yes and denies for a plain no. Anything other than a plain yes or no ("I believe so", "Not exactly", "Yes, but…") adopts nothing clearly.
- "I don't recall" and "I don't know" assert nothing.
- A witness repeating what someone else said or did, or what they heard, is secondhand: attribution reported_by_other.
- If the decisive question or answer is in an adjacent exchange, you may cite that adjacent exchange's ID instead of the pair's own exchange. Cite only exchange IDs shown in the pair's two passages; context lines marked "not citable" can't be cited.

Outcomes:
- direct: the witness's own assertions on the two sides cannot both be true as stated, about the same event, time and scope.
- inferential: a discrepancy a lawyer should review, which holds only through stated inference, or through details that may concern the same event but are not plainly the same.
- compatible: both can be true as stated: different events, times or propositions; approximations that overlap; or one side asserting nothing that conflicts with the other.
- clarification_or_correction: one side expressly clarifies, narrows or corrects the other ("what I meant was…", "let me correct that…", a later answer that revises an earlier one on the record).
- secondhand_or_uncertain: the apparent discrepancy rests on what someone else said, on hearsay, on the witness's lack of knowledge, or on a statement too qualified to compare; worth a lawyer's look but not the witness's own conflicting assertions.
- insufficient_evidence: the two passages don't let you tell either way.
- needs_more_context: specific testimony not shown would likely decide it.
- unable_to_assess: the text is unreadable, garbled, or not testimony.
Never force an outcome the lines don't support; abstain instead.

Grounding:
- Support every conflict with concrete details quoted from the cited lines: list each compared detail in detailsCompared with the words from each side (same, different, or only_one when one side doesn't state it). A direct outcome needs at least one detail that is different on the two sides.
- Never invent or assume dates, events, places, people, chronology or changed circumstances that the lines don't state, either to create a conflict or to explain one away. If only such an assumption would reconcile or connect the two sides, say so in alternativeExplanation and mark it speculative.
- Qualified statements ("I think", "maybe", "probably") can still conflict; record the qualification in the attribution fields.

Fields, for each verdict:
- pairId: as listed. outcome: one of the eight above.
- evidenceAId / evidenceBId: the exchange ID cited for each side: the pair's own exchange as listed, or one of that passage's adjacent exchanges.
- keyPhraseA / keyPhraseB: the shortest verbatim words from the cited exchange that carry the compared statement, copied exactly (they are checked against the transcript). For a bare answer, the question's words, as above. Null only for an abstention with nothing to cite.
- attributionA / attributionB: asserted, qualified, does_not_recall, reported_by_other, hypothetical, attorney_statement (an attorney's words the witness didn't adopt), unclear.
- stanceA / stanceB: affirms or denies the proposition in the key phrase, as above; unclear otherwise.
- sameEvent / scopeAligned: yes, no, uncertain.
- detailsCompared: the concrete details compared, as above; may be empty only when no detail is compared (an abstention, or compatible testimony about plainly different events).
- conflictBasis: for direct or inferential: explicit_negation, value_conflict, mutually_exclusive or requires_inference (requires_inference only with inferential); otherwise none.
- conflictSource: for direct or inferential, cited_exchanges (the conflict comes from the cited exchanges); otherwise none.
- explanation: two to four plain sentences a lawyer can check, citing page:line. It must agree with the outcome; for an abstention, say what is missing.
- alternativeExplanation: the strongest reading against your outcome, or null. alternativeSupport: established, plausible or speculative; null exactly when alternativeExplanation is null.
- contextUsed: each context line or range relied on ("40:03" or "40:02-40:03"), with its purpose: resolve_reference, clarify_event_time_or_scope, short_answer_question or same_event. Empty if none.`;

// ---------------------------------------------------------------------------------------------------
// packet-v3 (Milestone 2.5, second round). v1 and v2 above are unchanged. Same evidence display as v2
// (formatIssuePacketV2); the contract changes: every quote names the exchange whose lines hold it, a side
// may cite up to three exchanges, compared details point at those quotes, and needs_more_context has
// explicit triggers. Written from the v2 evaluation's failure kinds (a neighbour's words cited under the
// passage's ID, missing verdicts, outcomes contradicting their own explanation, no needs_more_context),
// not from any benchmark case's text.
export const PACKET_PROMPT_VERSION_V3 = "packet-v3";

export const PACKET_SYSTEM_PROMPT_V3 = `You review sworn deposition testimony for a lawyer. You receive passages from one case and a list of pairs to compare. Each passage is one question-and-answer exchange with its ID, witness and session, often shown with the exchanges just before and after it in the same deposition, each with its own ID. Every line shows its page:line and role: [Q] the examining attorney's question, [A] the witness's answer, [other] an attorney's remark, objection or colloquy. The two passages in a pair come from different sessions, and may be the same witness or two witnesses. You never give a confidence, score, rating or probability: code checks every quote and calculates any score.

Completeness: return exactly one verdict for every listed pair, each with its pairId, in the listed order, and nothing else. Never skip a pair, even a hard one: abstain instead. Judge each pair only on its own two passages (including their adjacent exchanges); other passages in the packet never count.

Citations, the most important rule: every quote must be copied exactly from the lines of the one exchange whose ID you give with it. If the words you need are in an adjacent exchange, give that adjacent exchange's ID, never the pair's own ID. If a statement spans a question in one exchange and its answer in the next, cite both, each with its own ID. Cite only IDs shown in the pair's two passages. Context lines marked "not citable" can't be cited.

Reading the testimony:
- Only the witness's own words, or a question the witness plainly adopted, are that witness's testimony. [other] lines never are.
- A bare answer ("Yes.", "No.", "No, he did not.", "Correct.") stands for the question it answers: quote the question's words that carry the proposition (with the question's exchange ID), stance affirms for a plain yes, denies for a plain no. Anything other than a plain yes or no adopts nothing clearly.
- "I don't recall" and "I don't know" assert nothing. Repeating what someone else said or did is secondhand (attribution reported_by_other).

Outcomes (pick the one the quoted lines support):
- direct: the witness's own assertions cannot both be true as stated, about the same event, time and scope.
- inferential: a discrepancy worth a lawyer's review that holds only through stated inference, or through details that may concern the same event but aren't plainly the same.
- compatible: both can be true as stated (different events, times or propositions; overlapping approximations; one side asserting nothing that conflicts).
- clarification_or_correction: one side expressly clarifies, narrows or corrects the other.
- secondhand_or_uncertain: the apparent discrepancy rests on what someone else said, on hearsay, on lack of knowledge, or on statements too qualified to compare.
- needs_more_context: deciding turns on something the shown lines leave open, such as what a "that", "it" or "then" refers to, whether two descriptions are the same occasion, or a question whose answer isn't shown. Say exactly what is missing.
- insufficient_evidence: the two passages don't bear on each other enough to tell.
- unable_to_assess: the text is unreadable, garbled, or not testimony.
Choose by the lines, not by how interesting the pair looks; don't force any outcome, and don't avoid abstaining when the evidence is genuinely incomplete.

Grounding:
- A conflict (direct or inferential) needs at least one compared detail whose words on the two sides differ, each copied from a quote you cited. A direct outcome needs a detail with relation different.
- Never invent or assume dates, people, places, events or chronology the lines don't state, to create a conflict or to explain one away. If only such an assumption would connect or reconcile the sides, say so in alternativeExplanation, marked speculative.
- Your explanation must agree with your outcome: if you write that the statements are consistent, the outcome is not a conflict.

Fields, for each verdict:
- pairId: as listed. outcome: one of the eight above.
- sideA / sideB: citations (each {exchangeId, quote}: the first is the side's key statement; at most three; none only for an abstention with nothing to cite), attribution (asserted, qualified, does_not_recall, reported_by_other, hypothetical, attorney_statement, unclear) and stance (affirms, denies, unclear) for the key statement.
- sameEvent / scopeAligned: yes, no, uncertain.
- details: each compared detail {detail, sideA, sideB, relation}: sideA and sideB are exact words from that side's citations ("" when the side doesn't state it); relation same, different or only_one. Empty only when nothing is compared.
- conflictBasis: for direct or inferential: explicit_negation, value_conflict, mutually_exclusive or requires_inference (requires_inference only with inferential); otherwise none.
- explanation: one to three plain sentences citing page:line, agreeing with the outcome; for an abstention, what is missing.
- alternativeExplanation: the strongest reading against your outcome, or null; alternativeSupport established, plausible or speculative, null exactly when alternativeExplanation is null.`;

// All versions, for callers that run any. v1's and v2's text, schema and formatter are the ones above, unchanged.
export type PromptVersionId = typeof PACKET_PROMPT_VERSION | typeof PACKET_PROMPT_VERSION_V2 | typeof PACKET_PROMPT_VERSION_V3;
export const PACKET_PROMPTS = {
  [PACKET_PROMPT_VERSION]: { system: PACKET_SYSTEM_PROMPT, jsonSchema: PACKET_REPLY_JSON_SCHEMA, format: formatIssuePacket, adjacent: false },
  [PACKET_PROMPT_VERSION_V2]: { system: PACKET_SYSTEM_PROMPT_V2, jsonSchema: PACKET_REPLY_V2_JSON_SCHEMA, format: formatIssuePacketV2, adjacent: true },
  [PACKET_PROMPT_VERSION_V3]: { system: PACKET_SYSTEM_PROMPT_V3, jsonSchema: PACKET_REPLY_V3_JSON_SCHEMA, format: formatIssuePacketV2, adjacent: true },
} as const;
