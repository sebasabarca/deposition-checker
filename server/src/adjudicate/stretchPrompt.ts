// The whole-stretch request (contract "stretch-v2", experimental and off by default): the system prompt and reply
// schema of the candidate-reduction experiment's v2 pilot (experiments/candidate-reduction/stretch/v2/contract.ts,
// branch experiment/candidate-reduction 31590cd), byte for byte (STRETCH_V2_SYSTEM_PROMPT_SHA256 pins it), and a
// renderer adapted to production evidence: passages come from packetLoad.ts (parser r12 segments, "(part x of y)"
// labels on a line shared by two turns), each stored line or line part is shown once per stretch, in transcript
// order (render r2, below), and only the exchanges are citable. Pure: no I/O.
//
// What differs from the experiment's renderer, so results from its pilot don't transfer as measurements:
// - Lines shared by two exchanges are shown as each exchange's own slice, with its part label, never whole.
// - Not-citable lines are the passages' stored context lines (packet-v1's context window) that no shown exchange
//   holds, not every stored line between two exchanges; a long run of colloquy between exchanges may show less.
// - Stretches and units are derived from the request's own pairs and passages (retrieve/stretchSet.ts), not frozen.

import { z } from "zod";
import { buildUnits, STRETCH_SETTINGS } from "../retrieve/stretchSet";
import { spanLabel } from "./packet";
import { PairVerdict } from "./packetSchema";
import type { IssuePacket, PassageLine } from "./packetPrompt";

export const STRETCH_V2_PROMPT_VERSION = "stretch-v2";
export const STRETCH_V2_SYSTEM_PROMPT_SHA256 = "b312bfb2d9fa2e5b6803ce6f86932efa0a98ba64e588f47bb56c2353b690013e";

export const STRETCH_V2_SYSTEM_PROMPT = `You review sworn deposition testimony for a lawyer. You receive stretches of testimony from one case, each shown once as continuous transcript and labelled with its witness and deposition session. Inside a stretch, every question-and-answer exchange is marked with its ID (for example "Exchange [E1234]"); lines between exchanges, and context before or after a stretch, are shown but are not citable. The stretches are grouped into UNITS: a unit names the exchanges of two stretches, A and B, from two different sessions; they may be the same witness or two different witnesses. You never give a confidence, score, rating or probability: code verifies your citations and calculates any score.

For each unit, compare every exchange of stretch A with every exchange of stretch B, and report every pair of exchanges whose testimony is inconsistent, or would be with specific lines outside the request. Report a finding only for these outcomes; report nothing for compatible testimony. Several findings may come from the same unit, and one exchange may be part of several findings. Judge each finding on its own two exchanges: another exchange never supports or refutes a finding it is not part of.

Each unit also lists ORIGINAL PAIRS. After writing your findings, give every listed pair exactly one ledger status: checked (you compared the two exchanges; any conflict between them is in your findings) or unclear (you cannot tell from the testimony shown whether they conflict). The ledger records coverage only: whether a pair conflicts is read from your findings, never from the ledger. Never omit a listed pair, and never list one that is not shown.

Read carefully:
- Q lines are the examining attorney's questions. A lines and "THE WITNESS:" lines are the witness of that passage. "MR."/"MS." lines are attorneys (objections, colloquy). Only the witness's own words, or a question the witness plainly adopted with a yes or no, are that witness's testimony.
- A plain "Yes." adopts the question's proposition. A plain "No." denies it: the witness asserts the opposite. Anything else ("I believe so", "Not exactly", "Yes, but…", a nonresponsive answer, or a bare yes or no to a negatively phrased or tag question) is not a clear adoption.
- "I don't recall" and "I don't know" are not assertions, and are not denials.
- When the two passages are different witnesses, compare what each witness asserts; a witness repeating what someone else said is reported_by_other.

Outcomes for a finding. Judge what was said, as stated:
- direct: materially incompatible assertions about the same proposition, event or time. They cannot both be true as stated.
- inferential: a conflict that holds only through reasonable inference steps, which your explanation states.
- needs_more_context: specific lines outside the request would likely decide whether there is a conflict (for example, what an answer refers to).
Testimony that both can be true as stated (different events or propositions, approximate values that overlap, a statement of no memory that asserts nothing inconsistent) is not a finding.

Qualification and uncertainty:
- A qualified statement can still contradict. "I think I went out" against "I was home all evening" is a potential conflict. Do not call a pair compatible because a statement contains "I think", "maybe", "probably" or "approximately"; record the qualification in the attribution fields.
- Approximations are compatible only when the values overlap within their stated hedges.
- Do not invent events, chronology or changed circumstances to dismiss an apparent inconsistency. If only a hypothetical intervening event could reconcile them, keep the potential conflict and give that reconciliation as the alternative explanation, marked plausible or speculative.
- Do not force a conflict when the testimony clearly concerns different events or propositions.

Evidence grounding:
- A conflict must be supported by the finding's two exchanges themselves. For a short answer, the question and its answer together are the testimony; when a short answer's question is a separate exchange, cite the exchange holding the words you quote.
- Lines marked not citable may only resolve references; clarify the event, time, subject or scope; show what a short answer adopts or denies; or establish whether two statements refer to the same event. List each one you rely on in contextUsed. They never supply a contradictory assertion of their own, and their words are never a key phrase: if the decisive words are only in such lines, the finding is needs_more_context.

Fields, for each finding:
- outcome: direct, inferential or needs_more_context.
- evidenceAId / evidenceBId: an exchange ID from stretch A and one from stretch B of the same unit, exactly as shown (for example "E1234").
- keyPhraseA / keyPhraseB: the shortest verbatim words from that exchange that carry the statement being compared, copied exactly from that exchange's lines (they are checked against the transcript). Use the witness's words when the witness said it; use the question's words only when the witness answered it with a plain yes or no. Include any negation. Null only for needs_more_context with no statement to cite.
- attributionA / attributionB: asserted, qualified, does_not_recall, reported_by_other, hypothetical, attorney_statement (the attorney's words, not adopted), unclear.
- stanceA / stanceB: affirms (the witness's own words; any negation is in the phrase), denies (a question answered with a plain "No."), unclear.
- sameEvent / scopeAligned: yes, no, uncertain.
- conflictBasis: for direct or inferential: explicit_negation, value_conflict, mutually_exclusive or requires_inference; otherwise none.
- conflictSource: for direct or inferential, cited_exchanges; if the conflict needs a statement in lines that are not citable it is not grounded: use context and do not call it direct or inferential. Otherwise none.
- explanation: two to four plain sentences a lawyer can check against the lines, citing page:line. It must agree with the outcome; for needs_more_context, say what is missing.
- alternativeExplanation: the strongest reading against your outcome, or null. alternativeSupport: established, plausible or speculative; null exactly when alternativeExplanation is null.
- contextUsed: each not-citable line or range you relied on ("40:03" or "40:02-40:03") with its purpose: resolve_reference, clarify_event_time_or_scope, short_answer_question or same_event. Empty if none.

Return every unit, in order, with its findings (an empty list when there are none), and the complete ledger.`;

export const FINDING_OUTCOMES = ["direct", "inferential", "needs_more_context"] as const;
export const StretchFinding = PairVerdict.omit({ pairId: true, falsePositiveReason: true }).extend({ outcome: z.enum(FINDING_OUTCOMES) });
export type StretchFinding = z.infer<typeof StretchFinding>;
export const LEDGER_V2 = ["checked", "unclear"] as const;
export const StretchReplyV2 = z.strictObject({
  units: z.array(z.strictObject({ unitId: z.string(), findings: z.array(StretchFinding) })),
  ledger: z.array(z.strictObject({ pairId: z.string(), status: z.enum(LEDGER_V2) })),
});
export type StretchReplyV2 = z.infer<typeof StretchReplyV2>;
const { $schema: _unused, ...v2JsonSchema } = z.toJSONSchema(StretchReplyV2);
export const STRETCH_V2_REPLY_JSON_SCHEMA = v2JsonSchema;

// A unit as the model sees it: the exchange IDs of stretch A and stretch B, and the original pairs, A side first.
export type RequestUnit = { unitId: string; a: string[]; b: string[]; pairs: { pairId: string; a: string; b: string }[] };

// The request's units, derived from its pairs and passages (deterministic: the same packet gives the same units).
// A pair whose passages are oriented B to A in its unit is listed A first; `pairs` keeps the packet's pairId.
export function requestUnits(packet: IssuePacket): RequestUnit[] {
  const at = new Map(packet.passages.map((p) => [p.id, { key: p.id, document: `d${String(p.depositionId).padStart(9, "0")}`, groupId: p.groupId }]));
  const units = buildUnits(packet.pairs.map((p) => ({ a: p.a, b: p.b })), at, STRETCH_SETTINGS.gap);
  const pairOf = new Map(packet.pairs.map((p) => [p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`, p.pairId]));
  return units.map((u, n) => ({
    unitId: `U${n + 1}`, a: u.xKeys, b: u.yKeys,
    pairs: u.pairs.map(([a, b]) => ({ pairId: pairOf.get(a < b ? `${a}|${b}` : `${b}|${a}`)!, a, b })),
  }));
}

const ref = (l: PassageLine) => `${l.page}:${String(l.line).padStart(2, "0")}${spanLabel(l)}`;
const show = (ls: readonly PassageLine[]) => ls.map((l) => `  ${ref(l)}  ${l.text}`).join("\n");
const lineKey = (l: PassageLine) => `${l.id}:${l.span ? `${l.span.first}-${l.span.last}` : "all"}`;

// Which renderer drew a request's user message, for records: r1 printed each passage's "after" context before the
// next exchange, so a trailing window running past a short next exchange came out of transcript order; r2 orders
// every stretch by transcript position, and drops a shared line's whole text from the context when the stretch's
// exchanges already show every part of it (r1 printed it whole between the two slices). Otherwise r2 is
// byte-identical to r1.
export const STRETCH_RENDER_R1 = "stretch-render-r1";
export const STRETCH_RENDER_R2 = "stretch-render-r2";
export const STRETCH_RENDER_ID = STRETCH_RENDER_R2;
export type StretchRenderId = typeof STRETCH_RENDER_R1 | typeof STRETCH_RENDER_R2;

// A piece of a stretch: an exchange, one not-citable line (of context block `block`), or a gap marker, at a
// transcript position (page, line, then: -1 a gap before the line, 0 the whole line, n an exchange starting at its
// part n, 99 a gap after the line).
type Atom = { pos: [number, number, number]; text: string; block?: number };
const at = (l: PassageLine, sub = l.span?.first ?? 0): Atom["pos"] => [l.page, l.line, sub];
const byPos = (x: Atom, y: Atom) => x.pos[0] - y.pos[0] || x.pos[1] - y.pos[1] || x.pos[2] - y.pos[2];
const GAP = "[pages omitted from the transcript here]";

// The user message: each deposition's stretch once, as continuous testimony with every exchange marked, then the units.
export function formatStretchRequest(packet: IssuePacket, render: StretchRenderId = STRETCH_RENDER_ID): string {
  const units = requestUnits(packet);
  const inStretch = new Set(units.flatMap((u) => [...u.a, ...u.b]));
  const passages = packet.passages.filter((p) => inStretch.has(p.id));
  const docs = [...new Set(passages.map((p) => p.depositionId))];
  const own = new Set(passages.flatMap((p) => p.lines.map(lineKey)));
  // r2: lines whose every part an exchange of the request shows (a line without a span is one whole part).
  const partsShown = new Map<number, { of: number; seen: Set<number> }>();
  for (const l of passages.flatMap((p) => p.lines)) {
    const e = partsShown.get(l.id) ?? partsShown.set(l.id, { of: l.span?.of ?? 1, seen: new Set() }).get(l.id)!;
    for (let i = l.span?.first ?? 1; i <= (l.span?.last ?? 1); i++) e.seen.add(i);
  }
  const whollyShown = (l: PassageLine) => render === STRETCH_RENDER_R2 && !l.span && (partsShown.get(l.id)?.seen.size ?? 0) >= (partsShown.get(l.id)?.of ?? Infinity);
  const blocks = docs.map((d, n) => {
    const ps = passages.filter((p) => p.depositionId === d).sort((x, y) => x.groupId - y.groupId);
    const shown = new Set<string>();
    let block = 0;
    const context = (ls: readonly PassageLine[]): Atom[] => { const out = ls.filter((l) => !own.has(lineKey(l)) && !shown.has(lineKey(l)) && !whollyShown(l)); out.forEach((l) => shown.add(lineKey(l))); block++; return out.map((l) => ({ pos: at(l), text: show([l]), block })); };
    const atoms: Atom[] = [];
    for (const p of ps) {
      const first = p.before[0] ?? p.lines[0], last = p.after[p.after.length - 1] ?? p.lines[p.lines.length - 1];
      const before = context(p.before);
      if (p.gapBefore) atoms.push({ pos: at(first, -1), text: GAP });
      atoms.push(...before);
      atoms.push({ pos: at(p.lines[0]), text: `Exchange [${p.id}] (${ref(p.lines[0])} to ${ref(p.lines[p.lines.length - 1])}):\n${show(p.lines)}` });
      p.lines.forEach((l) => shown.add(lineKey(l)));
      atoms.push(...context(p.after));
      if (p.gapAfter) atoms.push({ pos: at(last, 99), text: GAP });
    }
    // r2: a stable sort, so pieces already in order keep r1's order (and bytes); a context block split by an
    // exchange becomes two "Not citable" blocks.
    if (render === STRETCH_RENDER_R2) atoms.sort(byPos);
    const parts: string[] = [`<stretch id="X${n + 1}" witness="${ps[0].witnessName}" session="${ps[0].session}" taken_on="${ps[0].takenOn ?? "not stated"}">`];
    atoms.forEach((a, i) => {
      if (a.block === undefined) parts.push(a.text);
      else if (atoms[i - 1]?.block === a.block) parts[parts.length - 1] += `\n${a.text}`;
      else parts.push(`Not citable:\n${a.text}`);
    });
    parts.push("</stretch>");
    return parts.join("\n");
  });
  const list = (ids: string[]) => ids.map((id) => `[${id}]`).join(" ");
  const unitText = units.map((u) => [`UNIT ${u.unitId}`, `Stretch A: ${list(u.a)}`, `Stretch B: ${list(u.b)}`, "Original pairs:", ...u.pairs.map((p) => `- ${p.pairId}: [${p.a}] with [${p.b}]`)].join("\n"));
  const pairs = units.reduce((n, u) => n + u.pairs.length, 0);
  return [...blocks, ...unitText, `Compare the two stretches of each of these ${units.length} unit${units.length === 1 ? "" : "s"}, report your findings, and give each of the ${pairs} original pair${pairs === 1 ? "" : "s"} exactly one ledger status.`].join("\n\n");
}
