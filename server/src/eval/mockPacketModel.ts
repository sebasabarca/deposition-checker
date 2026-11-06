import { encodeCompact } from "../adjudicate/compactSchema";
import type { PairVerdict } from "../adjudicate/packetSchema";
import { formatIssuePacket, formatIssuePacketV2, PACKET_SYSTEM_PROMPT, PACKET_SYSTEM_PROMPT_V2, type IssuePacket, type PacketPassage } from "../adjudicate/packetPrompt";

const NEGATION = /\b(?:no|not|never|didn't|don't)\b/i;
const words = (text: string) => [...new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !["that", "this", "with", "from", "were", "have", "been", "said"].includes(w)))];
// The last answer line without its speaker label ("A.", "A:", "THE WITNESS:"), as a model would quote it.
const answerLine = (p: PacketPassage) => ([...p.lines].reverse().find((l) => l.role === "answer")?.text ?? p.lines.at(-1)?.text ?? "").replace(/^\s*(?:A[.:]|THE WITNESS:)\s*/i, "").trim();

// Mock outcomes exercise packet parsing, verification and scoring; they measure the pipeline, never model quality.
export function mockPacketReply(packet: IssuePacket, options: { drop?: string[]; duplicate?: string[]; garble?: boolean } = {}) {
  if (options.garble) return { text: "{not json", usage: { inputTokens: 0, outputTokens: 0 } };
  const byId = new Map(packet.passages.map((p) => [p.id, p])); const drop = new Set(options.drop ?? []); const duplicate = new Set(options.duplicate ?? []);
  const verdicts = packet.pairs.flatMap((pair) => {
    if (drop.has(pair.pairId)) return [];
    const a = answerLine(byId.get(pair.a)!); const b = answerLine(byId.get(pair.b)!); const shared = words(a).filter((w) => words(b).includes(w));
    const enough = a.split(/\s+/).filter(Boolean).length >= 3 && b.split(/\s+/).filter(Boolean).length >= 3; const direct = enough && NEGATION.test(a) !== NEGATION.test(b) && shared.length >= 2; const outcome = !enough ? "insufficient_evidence" : direct ? "direct" : "false_positive";
    const abstain = outcome === "insufficient_evidence";
    const verdict = { pairId: pair.pairId, outcome, evidenceAId: pair.a, evidenceBId: pair.b, keyPhraseA: abstain ? null : a, keyPhraseB: abstain ? null : b, attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "uncertain", scopeAligned: "uncertain", conflictBasis: direct ? "explicit_negation" : "none", conflictSource: direct ? "cited_exchanges" : "none", falsePositiveReason: outcome === "false_positive" ? "both_can_be_true" : null, explanation: abstain ? "The answer lines are too short to establish the comparison." : direct ? `The answer lines differ in negation: ${a} / ${b}.` : "The two answer lines can both be true.", alternativeExplanation: null, alternativeSupport: null, contextUsed: [] } as const;
    return duplicate.has(pair.pairId) ? [verdict, verdict] : [verdict];
  }).flat();
  const system = PACKET_SYSTEM_PROMPT; const user = formatIssuePacket(packet);
  return { text: JSON.stringify({ verdicts }), usage: { inputTokens: Math.ceil((system.length + user.length) / 3.5), outputTokens: 350 * verdicts.length } };
}

// packet-c3's form of the same label-blind decisions: a screen row per pair (dismissal rows for its false positives),
// full verdicts otherwise. Each row's quotes are words of its two answer lines, as the dismissal quote check requires.
export function mockCompactReply(packet: IssuePacket, options: { drop?: string[]; duplicate?: string[]; garble?: boolean } = {}) {
  const m = mockPacketReply(packet, options);
  if (options.garble) return m;
  const byId = new Map(packet.passages.map((p) => [p.id, p]));
  const pairs = new Map(packet.pairs.map((p) => [p.pairId, p]));
  const quote = (id: string) => answerLine(byId.get(id)!).split(/\s+/).slice(0, 12).join(" ");
  const reply = encodeCompact("packet-c3", (JSON.parse(m.text) as { verdicts: PairVerdict[] }).verdicts);
  for (const row of reply.screen) { const p = pairs.get(row.pairId)!; row.quoteA = quote(p.a); row.quoteB = quote(p.b); }
  return { ...m, text: JSON.stringify(reply) };
}

// The same label-blind mock in the packet-v2 contract: false_positive becomes compatible, and each verdict
// lists the compared answer as its one detail. Measures the v2 pipeline, never model quality.
export function mockPacketReplyV2(packet: IssuePacket, options: { drop?: string[]; duplicate?: string[]; garble?: boolean } = {}) {
  const v1 = mockPacketReply(packet, options);
  if (options.garble) return v1;
  const verdicts = (JSON.parse(v1.text) as { verdicts: Record<string, unknown>[] }).verdicts.map(({ falsePositiveReason: _fp, ...v }) => ({
    ...v,
    outcome: v.outcome === "false_positive" ? "compatible" : v.outcome,
    detailsCompared: v.keyPhraseA === null ? [] : [{ detail: "the answer", sideA: v.keyPhraseA, sideB: v.keyPhraseB, relation: v.outcome === "direct" ? "different" : "same" }],
  }));
  const user = formatIssuePacketV2(packet);
  return { text: JSON.stringify({ verdicts }), usage: { inputTokens: Math.ceil((PACKET_SYSTEM_PROMPT_V2.length + user.length) / 3.5), outputTokens: 400 * verdicts.length } };
}

// The same label-blind mock in the packet-v3 contract: each side cites its key statement with the exchange
// ID it comes from, and details quote those citations. Measures the v3 pipeline, never model quality.
export function mockPacketReplyV3(packet: IssuePacket, options: { drop?: string[]; duplicate?: string[]; garble?: boolean } = {}) {
  const v2 = mockPacketReplyV2(packet, options);
  if (options.garble) return v2;
  const verdicts = (JSON.parse(v2.text) as { verdicts: Record<string, any>[] }).verdicts.map((v) => ({
    pairId: v.pairId, outcome: v.outcome,
    sideA: { citations: v.keyPhraseA === null ? [] : [{ exchangeId: v.evidenceAId, quote: v.keyPhraseA }], attribution: v.attributionA, stance: v.stanceA },
    sideB: { citations: v.keyPhraseB === null ? [] : [{ exchangeId: v.evidenceBId, quote: v.keyPhraseB }], attribution: v.attributionB, stance: v.stanceB },
    sameEvent: v.sameEvent, scopeAligned: v.scopeAligned, details: v.detailsCompared, conflictBasis: v.conflictBasis,
    explanation: v.explanation, alternativeExplanation: v.alternativeExplanation, alternativeSupport: v.alternativeSupport,
  }));
  return { text: JSON.stringify({ verdicts }), usage: v2.usage };
}
