import { describe, expect, it } from "vitest";
import type { IssuePacket, PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import { parsePacketReply } from "../../server/src/adjudicate/packetSchema";
import { mockPacketReply } from "../../server/src/eval/mockPacketModel";
import { verifyPacketReply } from "../../server/src/verify/packet";

const passage = (id: string, answer: string): PacketPassage => ({
  key: `${id}#k`, id, depositionId: 1, groupId: 1, witnessId: 1, witnessName: "W", session: id, takenOn: null, partIds: [1], wholeExchange: true,
  lines: [{ id: Number(id.slice(1)) * 10, page: 1, line: 1, text: "Q. Did you see the truck at the station?", role: "question" }, { id: Number(id.slice(1)) * 10 + 1, page: 1, line: 2, text: `A. ${answer}`, role: "answer" }],
  before: [], after: [], gapBefore: false, gapAfter: false,
});
const packet: IssuePacket = {
  id: "P",
  passages: [passage("E1", "I saw the truck parked at the station."), passage("E2", "I never saw the truck parked at the station."), passage("E3", "Yes.")],
  pairs: [{ pairId: "R1", a: "E1", b: "E2" }, { pairId: "R2", a: "E1", b: "E3" }],
};

describe("mock packet model (label-blind)", () => {
  it("answers every pair with a reply that parses and whose own key phrases verify", () => {
    const m = mockPacketReply(packet);
    const v = verifyPacketReply(packet, parsePacketReply(m.text));
    expect(v.pairs.map((p) => [p.status, p.semantic?.outcome])).toEqual([["answered", "direct"], ["answered", "insufficient_evidence"]]);
    expect(v.pairs[0].source?.status).toBe("verified");
    expect(v.pairs[1].validationFailures).toEqual([]);
    expect(m.usage.outputTokens).toBe(700);
  });

  it("produces missing, duplicate and failed replies on request", () => {
    expect(verifyPacketReply(packet, parsePacketReply(mockPacketReply(packet, { drop: ["R2"] }).text)).pairs[1].status).toBe("missing");
    expect(verifyPacketReply(packet, parsePacketReply(mockPacketReply(packet, { duplicate: ["R1"] }).text)).pairs[0].status).toBe("duplicate");
    expect(verifyPacketReply(packet, parsePacketReply(mockPacketReply(packet, { garble: true }).text)).pairs.every((p) => p.status === "request_failed")).toBe(true);
  });
});
