import { describe, expect, it } from "vitest";
import { formatIssuePacket, formatIssuePacketV2, PACKET_PROMPTS, PACKET_SYSTEM_PROMPT, PACKET_SYSTEM_PROMPT_V2, type IssuePacket, type PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import { PACKET_REPLY_V2_JSON_SCHEMA, parsePacketReply, parsePacketReplyV2, type PairVerdictV2 } from "../../server/src/adjudicate/packetSchema";
import { mockPacketReplyV2 } from "../../server/src/eval/mockPacketModel";
import { scoreArm, type PairResult } from "../../server/src/eval/packetBenchmark";
import type { FrozenPair } from "../../server/src/retrieve/frozen";
import { verifyPacketReply } from "../../server/src/verify/packet";

type Line = PacketPassage["lines"][number];
const q = (id: number, page: number, line: number, text: string): Line => ({ id, page, line, text, role: "question" });
const a = (id: number, page: number, line: number, text: string): Line => ({ id, page, line, text, role: "answer" });

// Side A: "Tell me what happened." / "The dog ran out." with the decisive bare answer in the NEXT exchange.
const passageA: PacketPassage = {
  key: "docA#1:560-1:561", id: "E10", depositionId: 1, groupId: 10, witnessId: 1, witnessName: "Witness One", session: "s1", takenOn: null, partIds: [10], wholeExchange: true,
  lines: [q(1, 1, 560, "Q: Tell me what happened."), a(2, 1, 561, "A: The dog ran out.")],
  before: [], after: [{ id: 3, page: 1, line: 562, text: "Q: Out of the gate?" }], gapBefore: false, gapAfter: false,
  adjacent: [{ id: "E11", relation: "next", groupId: 11, itemKey: "docA#1:562-1:563", lines: [q(3, 1, 562, "Q: Out of the gate?"), a(4, 1, 563, "A: Yes.")] }],
};
const passageB: PacketPassage = {
  key: "docB#2:10-2:11", id: "E20", depositionId: 2, groupId: 20, witnessId: 2, witnessName: "Witness Two", session: "s2", takenOn: null, partIds: [20], wholeExchange: true,
  lines: [q(5, 2, 10, "Q: Did the dog get out of the gate?"), a(6, 2, 11, "A: The dog never left the yard.")],
  before: [], after: [], gapBefore: false, gapAfter: false,
  adjacent: [{ id: "E21", relation: "previous", groupId: 19, itemKey: null, lines: [q(7, 2, 8, "Q: Where was the dog?"), a(8, 2, 9, "A: In the yard.")] }],
};
const packet: IssuePacket = { id: "P", passages: [passageA, passageB], pairs: [{ pairId: "R1", a: "E10", b: "E20" }] };

const verdict = (over: Partial<PairVerdictV2> = {}): PairVerdictV2 => ({
  pairId: "R1", outcome: "direct", evidenceAId: "E11", evidenceBId: "E20", keyPhraseA: "Out of the gate", keyPhraseB: "The dog never left the yard",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  detailsCompared: [{ detail: "whether the dog left the gate", sideA: "Out of the gate? Yes.", sideB: "never left the yard", relation: "different" }],
  conflictBasis: "mutually_exclusive", conflictSource: "cited_exchanges", explanation: "1:562-563 against 2:11.", alternativeExplanation: null, alternativeSupport: null, contextUsed: [], ...over,
});
const verifyV2 = (v: PairVerdictV2[]) => verifyPacketReply(packet, parsePacketReplyV2(JSON.stringify({ verdicts: v })));

describe("packet-v2 contract", () => {
  it("keeps packet-v1 exactly as it was", () => {
    expect(PACKET_PROMPTS["packet-v1"].system).toBe(PACKET_SYSTEM_PROMPT);
    expect(PACKET_PROMPTS["packet-v1"].format).toBe(formatIssuePacket);
    expect(PACKET_PROMPTS["packet-v1"].adjacent).toBe(false);
    // v1 ignores adjacent exchanges entirely: its text is the same with or without them.
    expect(formatIssuePacket(packet)).toBe(formatIssuePacket({ ...packet, passages: packet.passages.map(({ adjacent: _a, ...p }) => p) }));
  });

  it("accepts the eight v2 outcomes and rejects a score, a v1 field, or a v1-only outcome", () => {
    for (const outcome of ["direct", "inferential", "compatible", "clarification_or_correction", "secondhand_or_uncertain", "insufficient_evidence", "needs_more_context", "unable_to_assess"] as const) {
      expect(parsePacketReplyV2(JSON.stringify({ verdicts: [verdict({ outcome })] })).ok, outcome).toBe(true);
    }
    expect(parsePacketReplyV2(JSON.stringify({ verdicts: [{ ...verdict(), confidence: 0.8 }] })).ok).toBe(false);
    expect(parsePacketReplyV2(JSON.stringify({ verdicts: [{ ...verdict(), falsePositiveReason: null }] })).ok).toBe(false);
    expect(parsePacketReplyV2(JSON.stringify({ verdicts: [verdict({ outcome: "false_positive" as never })] })).ok).toBe(false);
    expect(parsePacketReply(JSON.stringify({ verdicts: [verdict()] })).ok).toBe(false); // a v2 reply is not a v1 reply
    expect(JSON.stringify(PACKET_REPLY_V2_JSON_SCHEMA)).not.toMatch(/confidence|probability|"score"/);
  });

  it("shows adjacent exchanges with their own IDs, roles and page:line, and marks plain context as not citable", () => {
    const text = formatIssuePacketV2(packet);
    expect(text).toContain("Exchange [E10] (1:560 to 1:561):\n  1:560 [Q] Q: Tell me what happened.\n  1:561 [A] A: The dog ran out.");
    expect(text).toContain("Adjacent exchange [E11] (next, 1:562 to 1:563):\n  1:562 [Q] Q: Out of the gate?\n  1:563 [A] A: Yes.");
    expect(text).toContain("Adjacent exchange [E21] (previous, 2:08 to 2:09)");
    const plain = formatIssuePacketV2({ ...packet, passages: [{ ...passageA, adjacent: [] }, passageB] });
    expect(plain).toContain("Context after (not citable):\n  1:562  Q: Out of the gate?");
  });

  it("asks for concrete details, a stance rule for bare answers, and no invented facts", () => {
    expect(PACKET_SYSTEM_PROMPT_V2).toContain("A bare answer");
    expect(PACKET_SYSTEM_PROMPT_V2).toContain("Never invent or assume dates, events");
    expect(PACKET_SYSTEM_PROMPT_V2).toContain("detailsCompared");
    expect(PACKET_SYSTEM_PROMPT_V2).toContain("never give a confidence, score, rating or probability");
  });
});

describe("packet-v2 verification", () => {
  it("verifies a citation of the side's own adjacent exchange, and records it as adjacent", () => {
    const p = verifyV2([verdict()]).pairs[0];
    expect(p.source?.a).toMatchObject({ status: "verified", cited: "adjacent", citedId: "E11" });
    expect(p.source?.b).toMatchObject({ status: "verified", cited: "exchange" });
    expect(p.validationFailures).toEqual([]);
    expect(p.semantic?.consistencyIssues).toEqual([]);
  });

  it("never lets a side borrow the other side's exchange or its neighbours", () => {
    // A cites B's adjacent exchange: both sides then cite side B.
    const p = verifyV2([verdict({ evidenceAId: "E21", keyPhraseA: "In the yard" })]).pairs[0];
    expect(p.validationFailures).toContain("both sides cite the same passage");
    // A phrase that is only in the adjacent exchange can't be cited to the exchange itself.
    const q2 = verifyV2([verdict({ evidenceAId: "E10" })]).pairs[0];
    expect(q2.source?.a.status).not.toBe("verified");
    // An ID that isn't in the pair at all stays unsupported.
    expect(verifyV2([verdict({ evidenceAId: "E99" })]).pairs[0].source?.a.status).toBe("unsupported");
  });

  it("flags a direct verdict without a differing detail or resting on inference, keeping the model's outcome", () => {
    const same = verifyV2([verdict({ detailsCompared: [{ detail: "x", sideA: "a", sideB: "a", relation: "same" }] })]).pairs[0];
    expect(same.semantic).toMatchObject({ outcome: "direct", consistencyIssues: ["direct_without_different_detail"] });
    expect(verifyV2([verdict({ conflictBasis: "requires_inference" })]).pairs[0].semantic?.consistencyIssues).toContain("direct_requires_inference");
    expect(verifyV2([verdict({ outcome: "inferential", detailsCompared: [] })]).pairs[0].semantic?.consistencyIssues).toContain("conflict_without_details");
    // Interpretation problems never count as evidence-validation failures.
    expect(same.validationFailures).toEqual([]);
  });

  it("produces mock v2 replies that parse and verify", () => {
    const v = verifyPacketReply(packet, parsePacketReplyV2(mockPacketReplyV2(packet).text));
    expect(v.pairs[0].status).toBe("answered");
    expect(["direct", "compatible", "insufficient_evidence"]).toContain(v.pairs[0].semantic?.outcome);
  });
});

describe("packet-v2 scoring", () => {
  const labels: FrozenPair[] = [{ id: "T", category: "conflict", source: "x", left: ["a"], right: ["b"] }, { id: "N", category: "no_conflict", source: "x", left: ["c"], right: ["d"] }];
  const row = (x: string, y: string, outcome: PairResult["outcome"]): PairResult => ({ corpus: "c", evidence: "synthetic", packetId: "P", a: x, b: y, pairStatus: "answered", outcome, sourceStatus: "verified", citationsValid: true, attributionErrors: 0, consistencyIssues: 0 });
  it("reports review outcomes apart: never identified, never a flagged control", () => {
    const s = scoreArm("packet", [row("a", "b", "secondhand_or_uncertain"), row("c", "d", "clarification_or_correction")], labels).evidence.combined;
    expect(s.identifiedTargets).toBe(0);
    expect(s.surfacedForReview).toEqual(["T"]);
    expect(s.missedTargets).toEqual({ secondhand_or_uncertain: ["T:direct"] });
    expect(s.flaggedControls).toEqual([]);
    expect(s.controlsSurfacedForReview).toEqual(["N"]);
  });
});
