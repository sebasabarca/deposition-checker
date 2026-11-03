import { describe, expect, it } from "vitest";
import type { Candidate, CandidatePool, FrozenItem } from "../../server/src/retrieve/frozen";
import { DEFAULT_TRIAGE, contentWords, distinctiveness, passageRanks, triage } from "../../server/src/retrieve/triage";

const item = (document: string, groupId: number, question: string, answer: string): FrozenItem => ({
  key: `${document}#${groupId}`, document, witness: "W", session: document, groupId, positions: [`1:${groupId}`], sourceHash: "", question, answer, context: "",
});
// One path, rank r from a and r2 from b.
const cand = (a: string, b: string, r: number | null, r2: number | null = r): Candidate => ({ a, b, fused: 1 / (60 + Math.min(r ?? 999, r2 ?? 999)), ranks: { P: [r, r2] } });
const pool = (candidates: Candidate[]): CandidatePool => ({ name: "t", perItem: 5, paths: ["P"], candidates });
// Filler items so that words used once or twice below are rare (df ≤ 1% of items).
const filler = Array.from({ length: 1000 }, (_, i) => item("z", 1000 + i, "Q: Filler question?", "A: Filler answer."));

// The rare-word gate and one partner passage per item, as first designed; the defaults now skip the gate and keep two.
const ORIGINAL = { rareShare: 0.01, perItem: 1 };

describe("contentWords", () => {
  it("drops short words, function words and courtroom fillers", () => {
    expect([...contentWords("Q: Okay. Did you see the limousine? A: Yes, I don't recall it.")]).toEqual(["see", "limousine"]);
  });
});

describe("triage", () => {
  it("accounts for every candidate, in kept or deferred with a stage and reason", () => {
    const items = [
      ...filler,
      item("x", 1, "", "APPEARANCES"),
      item("y", 1, "", "APPEARANCES"),
      item("x", 2, "Q: Where was the Bronco parked?", "A: Behind the garage on Ashford."),
      item("y", 2, "Q: Where was the Bronco parked?", "A: Behind the garage on Ashford."),
      item("x", 3, "Q: Okay?", "A: Yes."),
      item("y", 3, "Q: Was the Bronco by the gate?", "A: It was out front on Rockingham."),
      item("y", 4, "Q: What did you eat?", "A: Dinner with friends."),
    ];
    const p = pool([cand("x#1", "y#1", 1), cand("x#2", "y#2", 1), cand("x#3", "y#3", 2), cand("x#2", "y#4", 3), cand("x#2", "y#3", 2)]);
    const r = triage(p, items, ORIGINAL);
    expect(r.kept.length + r.deferred.length).toBe(5);
    expect(Object.fromEntries(r.deferred.map((d) => [`${d.candidate.a}|${d.candidate.b}`, d.stage]))).toEqual({
      "x#1|y#1": "not-testimony",
      "x#2|y#2": "near-duplicate",
      "x#3|y#3": "content-poor",
      "x#2|y#4": "no-rare-word",
    });
    expect(r.kept.map((c) => c.b)).toEqual(["y#3"]);
    expect(r.deferred.every((d) => d.reason.length > 0)).toBe(true);
    expect(r.stages.map((s) => [s.name, s.in, s.out])).toEqual([
      ["not-testimony", 5, 4], ["near-duplicate", 4, 3], ["content-poor", 3, 2], ["no-rare-word", 2, 1], ["coverage", 1, 1],
    ]);
  });

  it("refuses candidates whose items are missing rather than dropping them", () => {
    expect(() => triage(pool([cand("x#1", "y#9", 1)]), [item("x", 1, "Q: a?", "A: b.")])).toThrow(/not in the items/);
  });

  it("keeps each item's best partner passage, counting neighbouring answers as one passage", () => {
    const words = "Q: Did the Bronco leave Rockingham?";
    const items = [...filler, item("x", 1, words, "A: The Bronco stayed."), item("x", 50, words, "A: Somebody drove it away after midnight."), ...[1, 2, 9, 20].map((g) => item("y", g, words, "A: The Bronco left Rockingham."))];
    // x#1 ranks y#1 first, y#20 second, y#2 third, y#9 fourth; with gap 5, y#1 and y#2 are one passage.
    // Every y item prefers x#50, so a y item never keeps x#1 by its own ranking.
    const ys = [1, 20, 2, 9];
    const p = pool([...ys.map((g, i) => cand("x#1", `y#${g}`, i + 1, 2)), ...ys.map((g, i) => cand("x#50", `y#${g}`, i + 1, 1))]);
    const keptFromX1 = (gap: number) => triage(p, items, { ...ORIGINAL, passageGap: gap }).kept.filter((c) => c.a === "x#1").map((c) => c.b).sort();
    expect(keptFromX1(5)).toEqual(["y#1", "y#2"]);
    expect(keptFromX1(0)).toEqual(["y#1"]);
    const r = triage(p, items, { ...ORIGINAL, passageGap: 5 });
    expect(r.deferred.filter((d) => d.stage === "coverage").map((d) => d.reason)).toContain("passage rank 2 from a, 2 from b; each item keeps 1");
    const { ranks } = passageRanks(p.candidates, new Map(items.map((i) => [i.key, i])), 5);
    expect(p.candidates.slice(0, 4).map((c) => ranks.get(c)![0])).toEqual([1, 2, 1, 3]);
  });

  it("orders the budget by the ratio test and defers the rest with their position", () => {
    const items = [...filler, ...[1, 2, 3].map((g) => item("x", g, "Q: Was the Bronco white?", "A: White Bronco.")), ...[1, 2, 3].map((g) => item("y", g * 10, "Q: Was the Bronco white?", "A: White Bronco, parked outside."))];
    // y#10 is a hub: x#1, x#2 and x#3 all rank it first. x#1 also ranks y#20 a close second, so its choice
    // (and the hub's, x#1) is not distinctive; x#2's runner-up is far behind; leaf pairs have no alternative.
    const p = pool([cand("x#1", "y#10", 1, 1), cand("x#1", "y#20", 2, 1), cand("x#2", "y#10", 1, 2), cand("x#2", "y#30", 40, 1), cand("x#3", "y#10", 1, 3)]);
    const r = triage(p, items, { ...ORIGINAL, maxPairs: 4, passageGap: 0 });
    expect(r.stages.find((s) => s.name === "coverage")).toMatchObject({ in: 5, out: 5 });
    expect(r.kept.map((c) => `${c.a}|${c.b}`)).toEqual(["x#1|y#20", "x#2|y#30", "x#3|y#10", "x#2|y#10"]);
    expect(r.deferred).toEqual([{ candidate: p.candidates[0], stage: "budget", reason: "distinctiveness 1.016: position 5 of 5 beyond budget 4" }]);
  });
});

describe("distinctiveness", () => {
  it("is the chosen passage's score over the next one, best over the choosing sides", () => {
    expect(distinctiveness([1, 3], [[4, 2], [9, 8, 7]], 1)).toBe(2);
    expect(distinctiveness([1, 1], [[4, 2], [5]], 1)).toBe(Infinity);
    expect(distinctiveness([2, 2], [[4, 2], [5, 1]], 1)).toBe(0);
  });
});

describe("the measured defaults", () => {
  it("skip the rare-word gate and keep each item's two best partner passages", () => {
    expect(DEFAULT_TRIAGE).toMatchObject({ rareShare: null, perItem: 2, maxPairs: null });
  });
});

