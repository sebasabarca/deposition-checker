import { describe, expect, it } from "vitest";
import type { IssuePacket, PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import { parsePacketReply, type PairVerdict } from "../../server/src/adjudicate/packetSchema";
import { verifyPacketReply } from "../../server/src/verify/packet";

const passage = (id: string, witnessId: number, answer: string, question = "Where were you?"): PacketPassage => ({
  key: `${id}#1`, id, depositionId: Number(id.slice(1)), groupId: 1, witnessId, witnessName: `Witness ${witnessId}`, session: id,
  takenOn: null, partIds: [1], wholeExchange: true,
  lines: [{ id: Number(id.slice(1)) * 10, page: 1, line: 1, text: `Q. ${question}`, role: "question" }, { id: Number(id.slice(1)) * 10 + 1, page: 1, line: 2, text: `A. ${answer}`, role: "answer" }],
  before: [], after: [], gapBefore: false, gapAfter: false,
});

const packet: IssuePacket = { id: "P1", passages: [passage("E1", 1, "I was home."), passage("E2", 1, "I went out."), passage("E3", 1, "I was downtown.")], pairs: [{ pairId: "R1", a: "E1", b: "E2" }] };
const verdict = (over: Partial<PairVerdict> = {}): PairVerdict => ({
  pairId: "R1", outcome: "direct", evidenceAId: "E1", evidenceBId: "E2", keyPhraseA: "I was home", keyPhraseB: "I went out",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  conflictBasis: "mutually_exclusive", conflictSource: "cited_exchanges", falsePositiveReason: null, explanation: "The accounts differ.", alternativeExplanation: null, alternativeSupport: null, contextUsed: [], ...over,
});
const verify = (p: IssuePacket, verdicts: PairVerdict[] | null) => verifyPacketReply(p, verdicts === null ? parsePacketReply(null) : parsePacketReply(JSON.stringify({ verdicts })));

describe("packet reply verifier", () => {
  it("keeps source, attribution and model semantics independent", () => {
    const result = verify(packet, [verdict({ outcome: "false_positive", falsePositiveReason: "both_can_be_true", conflictBasis: "none", conflictSource: "none" })]);
    expect(result.pairs[0]).toMatchObject({ status: "answered", source: { status: "verified" }, semantic: { outcome: "false_positive" } });
    expect(result.pairs[0].attribution?.a?.level).toBe("clear");
  });

  it("records missing, duplicate, unknown and failed replies", () => {
    const missing = verify({ ...packet, pairs: [...packet.pairs, { pairId: "R2", a: "E1", b: "E3" }] }, [verdict()]);
    expect(missing.pairs[1]).toMatchObject({ status: "missing" });
    const duplicate = verify(packet, [verdict(), verdict({ explanation: "again" })]);
    expect(duplicate.pairs[0]).toMatchObject({ status: "duplicate", duplicateCount: 2 });
    const unknown = verify(packet, [verdict(), verdict({ pairId: "R99" })]);
    expect(unknown.unknownPairIds).toEqual(["R99"]);
    const failed = verify(packet, null);
    expect(failed.pairs[0]).toMatchObject({ status: "request_failed", error: "no structured output", semantic: null });
  });

  it("accepts swapped IDs and rejects references outside the listed pair", () => {
    expect(verify(packet, [verdict({ evidenceAId: "E2", evidenceBId: "E1", keyPhraseA: "I went out", keyPhraseB: "I was home" })]).pairs[0].source).toMatchObject({ swapped: true, status: "verified" });
    expect(verify(packet, [verdict({ evidenceBId: "E3", keyPhraseB: "I was downtown" })]).pairs[0].source).toMatchObject({ status: "wrong_pair_reference", b: { status: "wrong_pair_reference" } });
    expect(verify(packet, [verdict({ evidenceAId: "E2", keyPhraseA: "I was home" })]).pairs[0].source).toMatchObject({ status: "wrong_reference" });
    expect(verify(packet, [verdict({ keyPhraseA: "fabricated words" })]).pairs[0].source).toMatchObject({ status: "unsupported" });
  });

  it("handles abstentions, substantive missing phrases, cross-witnesses and attribution disagreement", () => {
    const abstention = verify(packet, [verdict({ outcome: "unable_to_assess", keyPhraseA: null, keyPhraseB: null, conflictBasis: "none", conflictSource: "none" })]);
    expect(abstention.pairs[0].validationFailures).toEqual([]);
    expect(abstention.pairs[0].source).toMatchObject({ status: "not_cited" });
    const samePassage = verify(packet, [verdict({ evidenceBId: "E1", keyPhraseB: "I was home" })]);
    expect(samePassage.pairs[0].validationFailures).toContain("both sides cite the same passage");
    const substantive = verify(packet, [verdict({ keyPhraseA: null })]);
    expect(substantive.pairs[0].validationFailures).toContain("missing phrase on substantive outcome");
    const cross = { ...packet, passages: [passage("E1", 1, "I was home."), passage("E2", 2, "I went out.")] };
    expect(verify(cross, [verdict()]).pairs[0].source?.status).toBe("verified");
    const attorney = { ...packet, passages: [passage("E1", 1, "No.", "Did you sign the contract?"), packet.passages[1]] };
    const disagreement = verify(attorney, [verdict({ keyPhraseA: "Did you sign the contract", stanceA: "affirms" })]);
    expect(disagreement.pairs[0].attribution?.a).toMatchObject({ disagreement: "stance_conflict", claudeContradicted: true });
  });

  it("reports every semantic consistency issue without changing the outcome", () => {
    const checks: Partial<PairVerdict>[] = [
      { outcome: "direct", conflictSource: "context" },
      { outcome: "direct", falsePositiveReason: "both_can_be_true" },
      { outcome: "false_positive", falsePositiveReason: null, conflictBasis: "none", conflictSource: "none" },
      { outcome: "false_positive", falsePositiveReason: "both_can_be_true", conflictBasis: "value_conflict", conflictSource: "none" },
      { outcome: "false_positive", falsePositiveReason: "both_can_be_true", alternativeExplanation: "Another reading", alternativeSupport: null, conflictBasis: "none", conflictSource: "none" },
    ];
    const issues = checks.map((change) => verify(packet, [verdict(change)]).pairs[0]);
    expect(issues.map((x) => x.semantic?.consistencyIssues[0])).toEqual([
      "ungrounded", "false_positive_reason_on_non_false_positive", "false_positive_reason_missing", "conflict_basis_on_non_conflict", "alternative_support_mismatch",
    ]);
    // Interpretation problems never count as evidence-validation failures, and a verified source never changes the outcome.
    expect(issues.every((x) => x.validationFailures.length === 0 && x.source?.status === "verified")).toBe(true);
    expect(issues[0].semantic?.outcome).toBe("direct");
  });
});
