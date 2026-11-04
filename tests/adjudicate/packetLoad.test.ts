import { describe, expect, it } from "vitest";
import { buildIssuePacket, pairwisePackets } from "../../server/src/adjudicate/packetLoad";
import type { PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import type { EvidencePacket } from "../../server/src/retrieve/grouping";

const passage = (key: string, id: string): PacketPassage => ({
  key, id, depositionId: 1, groupId: 1, witnessId: 1, witnessName: "W", session: "s", takenOn: null,
  partIds: [1], wholeExchange: true, lines: [{ id: 1, page: 1, line: 1, text: key, role: "answer" }], before: [], after: [], gapBefore: false, gapAfter: false,
});

const base: EvidencePacket = { id: "P1", issue: "issue", items: ["a", "b", "c"], pairs: [["a", "b"], ["a", "c"]], inputTokens: 1 };

describe("packet loading helpers", () => {
  it("reports unresolved pairs and keeps only passages used by buildable pairs", () => {
    const result = buildIssuePacket(base, new Map([["a", passage("a", "E1")], ["b", passage("b", "E2")]]));
    expect(result.packet).toMatchObject({ id: "P1", passages: [expect.objectContaining({ key: "a" }), expect.objectContaining({ key: "b" })], pairs: [{ pairId: "R1", a: "E1", b: "E2" }] });
    expect(result.unbuilt).toEqual([{ a: "a", b: "c", reason: "item not resolved: c" }]);
  });

  it("rejects two different items that resolve to one passage and creates pairwise packets", () => {
    const one = passage("a", "E1");
    const result = buildIssuePacket({ ...base, items: ["a", "b"], pairs: [["a", "b"]] }, new Map([["a", one], ["b", { ...one, key: "b" }]]));
    expect(result.packet).toBeNull();
    expect(result.unbuilt[0].reason).toContain("same passage ID: E1");

    const packet = { id: "P2", passages: [passage("a", "E1"), passage("b", "E2")], pairs: [{ pairId: "R1", a: "E1", b: "E2" }, { pairId: "R2", a: "E2", b: "E1" }] };
    expect(pairwisePackets(packet)).toEqual([
      { id: "P2/R1", passages: packet.passages, pairs: [{ pairId: "R1", a: "E1", b: "E2" }] },
      { id: "P2/R2", passages: [packet.passages[1], packet.passages[0]], pairs: [{ pairId: "R1", a: "E2", b: "E1" }] },
    ]);
  });
});
