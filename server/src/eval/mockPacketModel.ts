import { formatIssuePacket, PACKET_SYSTEM_PROMPT, type IssuePacket, type PacketPassage } from "../adjudicate/packetPrompt";

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
