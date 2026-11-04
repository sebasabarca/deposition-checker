import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PACKET_PROMPTS, PACKET_SYSTEM_PROMPT, PACKET_SYSTEM_PROMPT_V2, PACKET_SYSTEM_PROMPT_V3, type IssuePacket, type PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import { PACKET_REPLY_V3_JSON_SCHEMA, PairVerdictV2, PairVerdictV3, parseVerdictsLenient, type PairVerdictV3 as V3 } from "../../server/src/adjudicate/packetSchema";
import { mockPacketReplyV3 } from "../../server/src/eval/mockPacketModel";
import { recoveryPlan, verifyPacketReply } from "../../server/src/verify/packet";

type Line = PacketPassage["lines"][number];
const q = (id: number, page: number, line: number, text: string): Line => ({ id, page, line, text, role: "question" });
const a = (id: number, page: number, line: number, text: string): Line => ({ id, page, line, text, role: "answer" });
const passage = (id: string, witnessId: number, lines: Line[], adjacent: PacketPassage["adjacent"] = []): PacketPassage => ({
  key: `${id}#k`, id, depositionId: witnessId, groupId: Number(id.slice(1)), witnessId, witnessName: `W${witnessId}`, session: `s${witnessId}`, takenOn: null, partIds: [Number(id.slice(1))], wholeExchange: true,
  lines, before: [], after: [], gapBefore: false, gapAfter: false, adjacent,
});
// Deposition 1 (witness 1): E10 and E12 are two passages with E11 between them, so E11 borders both (a shared
// neighbour). Deposition 2 (witness 2): E20, with its neighbour E21.
const E11 = { id: "E11", relation: "next" as const, groupId: 11, itemKey: null, lines: [q(3, 1, 3, "Q: Out of the gate?"), a(4, 1, 4, "A: Yes.")] };
const E11prev = { ...E11, relation: "previous" as const };
const p10 = passage("E10", 1, [q(1, 1, 1, "Q: Tell me what happened."), a(2, 1, 2, "A: The dog ran out.")], [E11]);
const p12 = passage("E12", 1, [q(5, 1, 5, "Q: And then?"), a(6, 1, 6, "A: I chased the dog down the alley.")], [E11prev]);
const p20 = passage("E20", 2, [q(7, 2, 1, "Q: Did the dog leave the yard?"), a(8, 2, 2, "A: The dog never left the yard.")], [{ id: "E21", relation: "previous", groupId: 19, itemKey: null, lines: [q(9, 1, 9, "Q: Where was the dog?"), a(10, 1, 10, "A: In the yard by the gate.")] }]);
const packet: IssuePacket = { id: "P", passages: [p10, p12, p20], pairs: [{ pairId: "R1", a: "E10", b: "E20" }, { pairId: "R2", a: "E12", b: "E20" }] };

const verdict = (over: Partial<V3> = {}): V3 => ({
  pairId: "R1", outcome: "direct",
  sideA: { citations: [{ exchangeId: "E11", quote: "Out of the gate" }], attribution: "asserted", stance: "affirms" },
  sideB: { citations: [{ exchangeId: "E20", quote: "The dog never left the yard" }], attribution: "asserted", stance: "affirms" },
  sameEvent: "yes", scopeAligned: "yes",
  details: [{ detail: "whether the dog left", sideA: "Out of the gate", sideB: "never left the yard", relation: "different" }],
  conflictBasis: "mutually_exclusive", explanation: "1:3-4 against 2:2.", alternativeExplanation: null, alternativeSupport: null, ...over,
});
const verify = (vs: unknown[]) => verifyPacketReply(packet, parseVerdictsLenient(JSON.stringify({ verdicts: vs }), PairVerdictV3) as never);

describe("packet-v1 and packet-v2 stay exactly as they were", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  it("pins both earlier prompts, which past paid runs used", () => {
    expect(sha(PACKET_SYSTEM_PROMPT)).toBe("f8bcab894837b79c242e31ad05511e91d8900c6604bcc5347a5a695b62921aa6");
    expect(sha(PACKET_SYSTEM_PROMPT_V2)).toBe("7d8b8efce6696da03a913e0fd347a71c12ad32e858d4d4ec71e72a91aaf83e7d");
    expect(PACKET_PROMPTS["packet-v3"].format).toBe(PACKET_PROMPTS["packet-v2"].format); // v3 changes the contract, not the evidence shown
  });
});

describe("packet-v3 contract", () => {
  it("asks for an exchange ID with every quote, every pair answered, and needs_more_context when evidence is open", () => {
    expect(PACKET_SYSTEM_PROMPT_V3).toContain("every quote must be copied exactly from the lines of the one exchange whose ID you give with it");
    expect(PACKET_SYSTEM_PROMPT_V3).toContain("Never skip a pair");
    expect(PACKET_SYSTEM_PROMPT_V3).toContain("needs_more_context: deciding turns on something the shown lines leave open");
    expect(PACKET_SYSTEM_PROMPT_V3).toContain("Never invent or assume dates, people, places, events or chronology");
    expect(PACKET_SYSTEM_PROMPT_V3).not.toMatch(/limo|SUV|gate|Simpson|Hutchinson|Resnick/i);
    expect(JSON.stringify(PACKET_REPLY_V3_JSON_SCHEMA)).not.toMatch(/confidence|probability|"score"/);
    expect(PairVerdictV3.safeParse({ ...verdict(), confidence: 1 }).success).toBe(false);
  });

  it("produces mock replies that parse and verify", () => {
    const v = verifyPacketReply(packet, parseVerdictsLenient(mockPacketReplyV3(packet).text, PairVerdictV3) as never);
    expect(v.pairs.map((p) => p.status)).toEqual(["answered", "answered"]);
  });
});

describe("shared-neighbour provenance", () => {
  it("lets a neighbour shared by two passages support either one, as an adjacent citation", () => {
    const r1 = verify([verdict(), verdict({ pairId: "R2" })]);
    expect(r1.pairs[0].source?.a).toMatchObject({ status: "verified", cited: "adjacent", citedId: "E11" });
    expect(r1.pairs[1].source?.a).toMatchObject({ status: "verified", cited: "adjacent", citedId: "E11" }); // the same E11, bordering E12
    expect(r1.pairs.every((p) => p.validationFailures.length === 0)).toBe(true);
  });

  it("never lets a side cite the other side's neighbour, and says so", () => {
    const r = verify([verdict({ sideA: { citations: [{ exchangeId: "E21", quote: "In the yard by the gate" }], attribution: "asserted", stance: "affirms" } }), verdict({ pairId: "R2" })]);
    expect(r.pairs[0].validationFailures).toContain("both sides cite the same passage");
  });

  it("rejects a citation of another passage of the packet that isn't in the pair", () => {
    const r = verify([verdict({ sideA: { citations: [{ exchangeId: "E12", quote: "I chased the dog down the alley" }], attribution: "asserted", stance: "affirms" } }), verdict({ pairId: "R2" })]);
    expect(r.pairs[0].source?.a).toMatchObject({ status: "wrong_pair_reference", diagnosis: "cites_other_passage" });
  });
});

describe("citation diagnostics (the reply is never rewritten)", () => {
  it("names the exchange that holds a quote cited under the passage's own ID", () => {
    const v = verdict({ sideA: { citations: [{ exchangeId: "E10", quote: "Out of the gate" }], attribution: "asserted", stance: "affirms" } });
    const r = verify([v, verdict({ pairId: "R2" })]);
    expect(r.pairs[0].source?.a).toMatchObject({ diagnosis: "phrase_in_other_exchange", foundIn: [{ exchangeId: "E11", relation: "own_adjacent" }] });
    expect(r.pairs[0].source?.a.status).not.toBe("verified");
    expect(r.pairs[0].source?.a.reason).toContain("the quote is in E11");
    expect((r.pairs[0].verdict as V3).sideA.citations[0].exchangeId).toBe("E10"); // kept as the model gave it
  });

  it("tells an unknown ID from an unsupported quote", () => {
    const unknown = verify([verdict({ sideA: { citations: [{ exchangeId: "E99", quote: "Out of the gate" }], attribution: "asserted", stance: "affirms" } }), verdict({ pairId: "R2" })]);
    expect(unknown.pairs[0].source?.a).toMatchObject({ status: "unsupported", diagnosis: "phrase_in_other_exchange" }); // the ID is invalid, but the quote is found
    const nowhere = verify([verdict({ sideA: { citations: [{ exchangeId: "E99", quote: "words nobody said" }], attribution: "asserted", stance: "affirms" } }), verdict({ pairId: "R2" })]);
    expect(nowhere.pairs[0].source?.a).toMatchObject({ status: "unsupported", diagnosis: "invalid_exchange_id" });
    const invented = verify([verdict({ sideA: { citations: [{ exchangeId: "E11", quote: "words nobody said" }], attribution: "asserted", stance: "affirms" } }), verdict({ pairId: "R2" })]);
    expect(invented.pairs[0].source?.a).toMatchObject({ status: "unsupported", diagnosis: "unsupported_quotation" });
  });

  it("checks every further citation of a side, not just its key statement", () => {
    const v = verdict({ sideA: { citations: [{ exchangeId: "E11", quote: "Out of the gate" }, { exchangeId: "E10", quote: "The dog ran out" }, { exchangeId: "E10", quote: "made up" }], attribution: "asserted", stance: "affirms" } });
    const r = verify([v, verdict({ pairId: "R2" })]);
    expect(r.pairs[0].source?.supporting.map((s) => s.source.status)).toEqual(["verified", "unsupported"]);
    expect(r.pairs[0].validationFailures).toContain("A supporting citation unsupported (unsupported_quotation)");
  });
});

describe("verdict completeness", () => {
  it("keeps valid verdicts when another is malformed, and never reads missing or malformed as compatible", () => {
    const r = verify([verdict(), { pairId: "R2", outcome: "compatible" }, { pairId: "R9", outcome: "direct" }]);
    expect(r.pairs.map((p) => p.status)).toEqual(["answered", "malformed"]);
    expect(r.pairs[1].semantic).toBeNull();
    expect(r.unknownPairIds).toEqual(["R9"]);
    const missing = verify([verdict()]);
    expect(missing.pairs[1]).toMatchObject({ status: "missing", semantic: null });
  });

  it("counts a valid and a malformed entry for one pair as a duplicate", () => {
    expect(verify([verdict(), verdict({ pairId: "R2" }), { pairId: "R2" }]).pairs[1]).toMatchObject({ status: "duplicate", duplicateCount: 2 });
  });

  it("plans one bounded recovery request for exactly the unresolved pairs, and none after it", () => {
    const v = verify([verdict()]);
    const plan = recoveryPlan(packet, v);
    expect(plan.unresolved).toEqual([{ pairId: "R2", status: "missing" }]);
    expect(plan.packet).toMatchObject({ id: "P~recovery-1", pairs: [{ pairId: "R2", a: "E12", b: "E20" }] });
    expect(plan.packet!.passages.map((p) => p.id)).toEqual(["E12", "E20"]);
    expect(recoveryPlan(packet, v, 2).packet).toBeNull();
    expect(recoveryPlan(packet, verify([verdict(), verdict({ pairId: "R2" })])).packet).toBeNull();
  });
});

describe("semantic consistency", () => {
  it("makes a v3 detail quote that isn't in the side's citations a consistency issue", () => {
    const r = verify([verdict({ details: [{ detail: "date", sideA: "on June 12", sideB: "never left the yard", relation: "different" }] }), verdict({ pairId: "R2" })]);
    expect(r.pairs[0].semantic?.consistencyIssues).toContain("detail_not_in_cited_evidence");
    expect(r.pairs[0].semantic?.requiresReview).toBe(true);
  });

  it("flags, without deciding, an explanation that contradicts the outcome", () => {
    const direct = verify([verdict({ explanation: "These are consistent: both can be true." }), verdict({ pairId: "R2" })]).pairs[0].semantic!;
    expect(direct).toMatchObject({ outcome: "direct", reviewFlags: ["explanation_says_compatible"], requiresReview: true });
    const compatible = verify([verdict({ outcome: "compatible", conflictBasis: "none", details: [], explanation: "The later answer directly contradicts the first." }), verdict({ pairId: "R2" })]).pairs[0].semantic!;
    expect(compatible.reviewFlags).toContain("explanation_says_conflict");
    const negated = verify([verdict({ outcome: "compatible", conflictBasis: "none", details: [], explanation: "Nothing here contradicts the first answer." }), verdict({ pairId: "R2" })]).pairs[0].semantic!;
    expect(negated.reviewFlags).toEqual([]);
  });

  it("flags a v2 detail naming a specific nowhere in the evidence, never a mere paraphrase, and never deterministically", () => {
    const v2 = (detail: { detail: string; sideA: string; sideB: string }) => PairVerdictV2.parse({
      pairId: "R1", outcome: "direct", evidenceAId: "E10", evidenceBId: "E20", keyPhraseA: "The dog ran out", keyPhraseB: "The dog never left the yard",
      attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
      detailsCompared: [{ ...detail, relation: "different" }], conflictBasis: "mutually_exclusive", conflictSource: "cited_exchanges",
      explanation: "x", alternativeExplanation: null, alternativeSupport: null, contextUsed: [] });
    const run = (d: Parameters<typeof v2>[0]) => verifyPacketReply(packet, { ok: true, verdicts: [v2(d)], malformed: [] }).pairs[0].semantic!;
    const invented = run({ detail: "when", sideA: "the dog got out on June 12", sideB: "never left" });
    expect(invented.reviewFlags).toContain("detail_names_unseen_specific");
    expect(invented.consistencyIssues).not.toContain("detail_names_unseen_specific");
    expect(run({ detail: "whether the dog left", sideA: "it ran out of the gate", sideB: "it stayed home" }).reviewFlags).toEqual([]);
  });
});
