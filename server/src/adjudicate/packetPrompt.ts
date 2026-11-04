// The packet adjudication prompt (Milestone 2): several passages from one case and a list of pairs to
// compare, one verdict per pair (packetSchema.ts). Its rules are adjudicate-v3's (prompt.ts), restated for
// passages that may come from different sessions or different witnesses, plus abstentions as valid
// answers. Changing the wording is a new version; old versions stay so their replies can be re-read.
// The input is built from stored lines only (packetLoad.ts); this file is pure.

import { ADJUDICATION_MODEL } from "./prompt";
import { PACKET_REPLY_JSON_SCHEMA } from "./packetSchema";

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

export type PassageLine = { id: number; page: number; line: number; text: string };
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
};
export type PacketPair = { pairId: string; a: string; b: string }; // passage IDs ("E…")
export type IssuePacket = { id: string; passages: PacketPassage[]; pairs: PacketPair[] };

const ref = (l: PassageLine) => `${l.page}:${String(l.line).padStart(2, "0")}`;
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
