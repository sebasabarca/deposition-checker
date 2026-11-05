// The experimental whole-stretch contract (stretch-v2): stretch building, rendering against production passages,
// and the deterministic reading of a reply. Hand-built inputs; no database, model or network.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IssuePacket, PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import { PACKET_PROMPTS, requestChars } from "../../server/src/adjudicate/packetPrompt";
import { packetRequestParams } from "../../server/src/adjudicate/packetModel";
import { requestBody } from "../../server/src/adjudicate/packetBatch";
import { mockStretchReply, readStretchReply } from "../../server/src/adjudicate/stretch";
import { mockPacketReply } from "../../server/src/eval/mockPacketModel";
import { formatStretchRequest, requestUnits, STRETCH_V2_PROMPT_VERSION, STRETCH_V2_SYSTEM_PROMPT, STRETCH_V2_SYSTEM_PROMPT_SHA256 } from "../../server/src/adjudicate/stretchPrompt";
import { buildStretchSet, buildUnits } from "../../server/src/retrieve/stretchSet";
import type { FrozenItem } from "../../server/src/retrieve/frozen";

type Line = PacketPassage["lines"][number];
const line = (id: number, page: number, n: number, text: string, role: Line["role"], span?: Line["span"]): Line => ({ id, page, line: n, text, role, ...(span ? { span } : {}) });
// depositions 1 (W1, session s1) and 2 (W2, session s2); exchange E<10*dep+group>
const passage = (dep: number, group: number, q: string, a: string, extra: Partial<PacketPassage> = {}): PacketPassage => {
  const base = dep * 1000 + group * 10;
  return {
    key: `d${dep}#${group}`, id: `E${dep * 100 + group}`, depositionId: dep, groupId: group, witnessId: dep, witnessName: `Witness ${dep}`, session: `s${dep}`, takenOn: `2020-0${dep}-01`, partIds: [dep * 100 + group], wholeExchange: true,
    lines: [line(base, group, 1, `Q. ${q}`, "question"), line(base + 1, group, 2, `A. ${a}`, "answer")], before: [], after: [], gapBefore: false, gapAfter: false, ...extra,
  };
};
const P1 = [passage(1, 1, "Was the car red?", "The vehicle parked outside was painted red."), passage(1, 2, "Where were you?", "At home all evening."), passage(1, 3, "Who drove?", "My brother drove.")];
const P2 = [passage(2, 1, "What colour was the car?", "The vehicle parked outside was not painted red."), passage(2, 2, "Were you home?", "I went out to the bar."), passage(2, 9, "Did you sleep?", "Yes I slept fine.")];
const packet: IssuePacket = {
  id: "S1", passages: [...P1, ...P2],
  pairs: [{ pairId: "R1", a: "E101", b: "E201" }, { pairId: "R2", a: "E202", b: "E102" }, { pairId: "R3", a: "E103", b: "E209" }],
};

describe("the stretch-v2 contract", () => {
  it("sends the experiment's system prompt byte for byte, through the same request path as packet-v1", () => {
    expect(createHash("sha256").update(STRETCH_V2_SYSTEM_PROMPT).digest("hex")).toBe(STRETCH_V2_SYSTEM_PROMPT_SHA256);
    const params = packetRequestParams(formatStretchRequest(packet), 3, STRETCH_V2_PROMPT_VERSION);
    expect(params.system[0].text).toBe(STRETCH_V2_SYSTEM_PROMPT);
    expect(params.max_tokens).toBe(packetRequestParams("x", 3).max_tokens); // same output cap rule as packet-v1
    expect(requestBody({ customId: "c1", packet, contract: STRETCH_V2_PROMPT_VERSION }).params.messages[0].content).toBe(formatStretchRequest(packet));
    expect(requestBody({ customId: "c1", packet }).params.system[0].text).toBe(PACKET_PROMPTS["packet-v1"].system); // default unchanged
    expect(requestChars(packet, STRETCH_V2_PROMPT_VERSION)).toBe(STRETCH_V2_SYSTEM_PROMPT.length + formatStretchRequest(packet).length);
  });

  it("groups nearby pairs into units, each stretch spanning every item between its pairs, every pair kept", () => {
    const units = requestUnits(packet);
    expect(units.map((u) => [u.a, u.b, u.pairs.map((p) => p.pairId)])).toEqual([
      [["E101", "E102"], ["E201", "E202"], ["R1", "R2"]], // R2 oriented A from deposition 1
      [["E103"], ["E209"], ["R3"]], // group 9 is beyond the gap of 2: its own unit
    ]);
    expect(units[0].pairs[1]).toEqual({ pairId: "R2", a: "E102", b: "E202" });
  });

  it("renders each deposition once, exchanges citable, shared context once, and r12 part labels on split lines", () => {
    const shared = line(1012, 1, 3, "Q Next question?", "context");
    const split = [line(1011, 1, 2, "A. The vehicle parked outside was painted red.", "answer", { first: 1, last: 1, of: 2 })];
    const p = { ...packet, passages: packet.passages.map((x) => (x.id === "E101" ? { ...x, lines: [x.lines[0], ...split], after: [shared] } : x.id === "E102" ? { ...x, before: [shared] } : x)) };
    const text = formatStretchRequest(p);
    expect(text.match(/<stretch /g)).toHaveLength(2);
    expect(text).toContain('<stretch id="X1" witness="Witness 1" session="s1" taken_on="2020-01-01">');
    expect(text).toContain("Exchange [E101] (1:01 to 1:02 (part 1 of 2)):");
    expect(text.split("Q Next question?").length - 1).toBe(1); // context shared by two passages shown once
    expect(text).toContain("Not citable:\n  1:03  Q Next question?");
    expect(text).toContain("UNIT U1\nStretch A: [E101] [E102]\nStretch B: [E201] [E202]\nOriginal pairs:\n- R1: [E101] with [E201]\n- R2: [E102] with [E202]");
    expect(text.endsWith("Compare the two stretches of each of these 2 units, report your findings, and give each of the 3 original pairs exactly one ledger status.")).toBe(true);
  });

  it("builds whole-case stretch requests covering every kept pair, bundled by document pair", () => {
    const item = (doc: string, g: number): FrozenItem => ({ key: `${doc}#${g}`, document: doc, groupId: g, question: "q ".repeat(50), answer: "a ".repeat(50), context: "" } as unknown as FrozenItem);
    const items = [...[1, 2, 3, 4, 20].map((g) => item("dA", g)), ...[1, 2, 3, 30].map((g) => item("dB", g)), item("dC", 1)];
    const kept = [{ a: "dA#1", b: "dB#1" }, { a: "dB#2", b: "dA#3" }, { a: "dA#20", b: "dB#30" }, { a: "dA#1", b: "dC#1" }];
    const set = buildStretchSet(kept, items);
    expect(set.uncovered).toEqual([]);
    expect(set.packets.flatMap((p) => p.pairs)).toHaveLength(4);
    // dA~dB units bundle together (A: groups 1-3 incl. 2; B: 1-2), dA~dC is its own request
    expect(set.packets.map((p) => [p.id, p.items.length, p.pairs.length])).toEqual([["S1", 7, 3], ["S2", 2, 1]]);
    expect(set.packets[0].items).toContain("dA#2"); // an unpaired item between the pairs is shown
    expect(buildUnits(kept, new Map(items.map((i) => [i.key, i])))).toHaveLength(3);
  });
});

describe("reading a stretch-v2 reply", () => {
  const finding = (a: string, b: string, keyA: string, keyB: string, outcome = "direct") => ({
    outcome, evidenceAId: a, evidenceBId: b, keyPhraseA: keyA, keyPhraseB: keyB, attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms",
    sameEvent: "yes", scopeAligned: "yes", conflictBasis: "explicit_negation", conflictSource: "cited_exchanges", explanation: "At 1:02 red; at 1:02 not red.", alternativeExplanation: null, alternativeSupport: null, contextUsed: [],
  });
  const reply = (units: unknown[], ledger: unknown[]) => JSON.stringify({ units, ledger });

  it("derives each pair's status from verified evidence, keeps unverified and unclear ones visible, and audits inconsistencies", () => {
    const r = readStretchReply(packet, reply(
      [
        { unitId: "U1", findings: [finding("E101", "E201", "The vehicle parked outside was painted red.", "The vehicle parked outside was not painted red."), finding("E102", "E202", "words never said", "I went out to the bar.")] },
        { unitId: "U2", findings: [] },
      ],
      [{ pairId: "R1", status: "unclear" }, { pairId: "R2", status: "checked" }, { pairId: "R3", status: "unclear" }],
    ));
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.pairs.map((p) => [p.pairId, p]));
    expect(by.R1.status).toBe("flagged");
    expect(by.R1.audit.join()).toMatch(/INCONSISTENT/); // the ledger said unclear; the verified finding stands
    expect(by.R2.status).toBe("flagged_unverified"); // a quote not in the transcript
    expect(by.R3.status).toBe("unclear");
    // Flagged pairs come back as packet-v1 verdicts on the packet's own orientation (R2 is E202 -> E102).
    const v2 = r.verification.pairs.find((p) => p.pairId === "R2")!;
    expect(v2.verdict).toMatchObject({ evidenceAId: "E202", evidenceBId: "E102", keyPhraseA: "I went out to the bar." });
    expect(r.verification.pairs.find((p) => p.pairId === "R1")!.source!.status).toBe("verified");
    expect(v2.source!.status).not.toBe("verified");
  });

  it("marks pairs incomplete when their unit or ledger entry is missing, counts findings outside the original pairs, and never reverses sides", () => {
    const r = readStretchReply(packet, reply(
      [{ unitId: "U1", findings: [finding("E201", "E101", "The vehicle parked outside was not painted red.", "The vehicle parked outside was painted red."), finding("E101", "E202", "The vehicle parked outside was painted red.", "I went out to the bar.")] }],
      [{ pairId: "R1", status: "checked" }],
    ));
    const by = Object.fromEntries(r.pairs.map((p) => [p.pairId, p]));
    expect(by.R1.status).toBe("no_conflict_identified"); // the swapped finding is not counted for it
    expect(by.R1.audit.join()).toMatch(/sides swapped/);
    expect(by.R1.related).toBe(true);
    expect(by.R2.status).toBe("incomplete"); // no ledger status
    expect(by.R3.status).toBe("incomplete"); // unit U2 missing
    expect(r.problems).toContain("unit U2 missing");
    expect(r.outsidePairs).toBe(1); // E101 with E202 is no original pair; the swapped R1 finding is
  });

  it("treats an unparseable reply as nothing read", () => {
    for (const text of [null, "{nope", JSON.stringify({ units: [], ledger: [], extra: 1 })]) {
      const r = readStretchReply(packet, text);
      expect(r.ok).toBe(false);
      expect(r.pairs.every((p) => p.status === "incomplete")).toBe(true);
      expect(r.verification.pairs.every((p) => p.status !== "answered")).toBe(true);
    }
  });

  it("the test model's stretch reply flags exactly the pairs packet-v1's test model calls direct", () => {
    const m = mockStretchReply(packet);
    const r = readStretchReply(packet, m.text);
    expect(r.ok).toBe(true);
    const direct = (JSON.parse(mockPacketReply(packet).text) as { verdicts: { pairId: string; outcome: string }[] }).verdicts.filter((v) => v.outcome === "direct").map((v) => v.pairId);
    expect(direct).toEqual(["R1"]);
    expect(r.pairs.filter((p) => p.status === "flagged").map((p) => p.pairId)).toEqual(direct);
    expect(r.pairs.every((p) => p.status !== "incomplete")).toBe(true);
    expect(readStretchReply(packet, mockStretchReply(packet, { drop: ["R3"] }).text).pairs.find((p) => p.pairId === "R3")!.status).toBe("incomplete");
  });
});
