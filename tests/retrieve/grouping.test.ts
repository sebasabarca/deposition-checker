import { describe, expect, it } from "vitest";
import type { Candidate, CandidatePool, FrozenItem } from "../../server/src/retrieve/frozen";
import { coPacketed, groupPool, INSTRUCTION_TOKENS, itemTokens, pairwiseWorkload, workload } from "../../server/src/retrieve/grouping";

const item = (session: string, n: number, question: string, answer: string, context = ""): FrozenItem => ({
  key: `${session}#${n}`, document: session, witness: "W", session, groupId: n, positions: [`1:${n}`], sourceHash: "", question, answer, context,
});
const cand = (a: FrozenItem, b: FrozenItem, rank = 1): Candidate => {
  const [x, y] = a.key < b.key ? [a.key, b.key] : [b.key, a.key];
  return { a: x, b: y, fused: 1 / (60 + rank), ranks: { P: [rank, rank] } };
};
const pool = (candidates: Candidate[]): CandidatePool => ({ name: "t", perItem: 5, paths: ["P"], candidates });
// Filler so that the words below are rare.
const filler = Array.from({ length: 200 }, (_, i) => item(`f${i % 3}`, 1000 + i, "Q: Filler question here?", "A: Filler answer there."));

// One matter: the limousine on January 6, told in three sessions.
const limoJune = item("june", 1, "Q: Did Ornato describe the limousine ride?", "A: Ornato said the limousine went to the Ellipse on January 6.");
const limoSept = item("sept", 1, "Q: Who told you about the limousine?", "A: Ornato told me the limousine stopped near the Ellipse.");
const limoOct = item("oct", 1, "Q: The limousine at the Ellipse?", "A: Ornato never mentioned the limousine to me.");
// Another matter that shares only a common word or one name with the first.
const parking = item("sept", 2, "Q: Where did you park on January 6?", "A: In the garage on Fourth Street.");
const forklift = item("june", 2, "Q: Did Ornato drive the forklift?", "A: He drove the forklift into the loading bay.");
const items = [...filler, limoJune, limoSept, limoOct, parking, forklift];

describe("groupPool", () => {
  it("covers every pool pair in a packet or lists it, and packets span two sessions", () => {
    const p = pool([cand(limoJune, limoSept), cand(limoSept, limoOct), cand(limoJune, limoOct), cand(limoJune, parking, 3), cand(forklift, limoSept, 4)]);
    const set = groupPool(p, items, "t", "pool.json");
    const w = workload(set);
    expect(w.pairsCovered + w.uncovered).toBe(5);
    expect(set.uncovered).toEqual([]);
    for (const packet of set.packets) {
      expect(new Set(packet.items.map((k) => k.split("#")[0])).size).toBeGreaterThanOrEqual(2);
      for (const [a, b] of packet.pairs) expect(packet.items).toContain(a), expect(packet.items).toContain(b);
    }
    // The three limousine statements form one issue packet; parking and forklift stay out of it.
    const issue = set.packets.find((x) => x.id.startsWith("issue"))!;
    expect(issue.items).toEqual([limoJune.key, limoOct.key, limoSept.key].sort());
    expect(issue.issue).toMatch(/^Possible common issue/);
    expect(issue.issue).toMatch(/limousin/);
    expect(coPacketed(set, [limoJune.key], [limoOct.key])).toBe(true);
    expect(coPacketed(set, [parking.key], [forklift.key])).toBe(false);
  });

  it("never joins two statements on one shared name alone", () => {
    const set = groupPool(pool([cand(forklift, limoSept)]), items, "t", "pool.json", { residual: "none" });
    expect(set.packets).toEqual([]);
    expect(set.uncovered).toEqual([{ a: forklift.key, b: limoSept.key, reason: "items in different issue clusters (residual packing off)" }]);
  });

  it("keeps packets within the item and token bounds and lists pairs too large for any packet", () => {
    const huge = item("oct", 9, "Q: Tell me everything about the limousine.", `A: ${"Ornato limousine Ellipse. ".repeat(400)}`);
    const p = pool([cand(limoJune, limoSept), cand(limoSept, limoOct), cand(limoJune, limoOct), cand(limoJune, huge)]);
    const maxTokens = INSTRUCTION_TOKENS + itemTokens(limoJune) + itemTokens(limoSept) + 5;
    const set = groupPool(p, [...items, huge], "t", "pool.json", { maxItems: 2, maxTokens });
    for (const packet of set.packets) expect(packet.items.length).toBeLessThanOrEqual(2), expect(packet.inputTokens).toBeLessThanOrEqual(maxTokens);
    expect(set.uncovered).toEqual([{ a: limoJune.key, b: huge.key, reason: `the two passages alone exceed ${maxTokens} tokens` }]);
    expect(workload(set).pairsCovered).toBe(3);
  });

  it("lists same-session pairs as uncovered", () => {
    const set = groupPool(pool([cand(limoSept, parking)]), items, "t", "pool.json");
    expect(set.uncovered[0].reason).toBe("same session");
  });

  it("projects pair-by-pair tokens as instructions plus both passages per pair", () => {
    const w = pairwiseWorkload(pool([cand(limoJune, limoSept)]), items);
    expect(w).toEqual({ calls: 1, tokens: INSTRUCTION_TOKENS + itemTokens(limoJune) + itemTokens(limoSept) });
  });
});
