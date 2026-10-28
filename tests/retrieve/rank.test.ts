import { describe, expect, it } from "vitest";
import { rankPairs, type PartInfo, type TermFrequency } from "../../server/src/retrieve";

const weights: TermFrequency = { exchanges: 1000, frequency: new Map() }; // every term equally rare

// Parts of logical exchanges: deposition 1 group 7 and deposition 2 group 3 are each split in two.
const part = (id: number, depositionId: number, groupId: number, terms: string[]): PartInfo => ({ id, depositionId, groupId, terms });
const parts = new Map(
  [
    part(71, 1, 7, ["sap", "merger", "price", "board"]), // group 7, part 1
    part(72, 1, 7, ["sap", "merger", "price", "safra"]), // group 7, part 2
    part(80, 1, 8, ["ibm", "db2", "licens"]),
    part(31, 2, 3, ["sap", "merger", "price", "safra"]), // group 3, part 1
    part(32, 2, 3, ["sap", "merger", "zebra"]), // group 3, part 2
    part(40, 2, 4, ["ibm", "db2", "licens", "audit"]),
  ].map((p) => [p.id, p]),
);

describe("rankPairs", () => {
  it("turns every part pair of two split exchanges, from both directions, into one candidate with its best parts", () => {
    const pairs = rankPairs(
      [
        { source: 71, target: 31 },
        { source: 71, target: 32 },
        { source: 72, target: 32 },
        { source: 31, target: 72 }, // the best part pair, found from the other side
        { source: 32, target: 71 },
      ],
      parts,
      weights,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      rank: 1,
      a: { depositionId: 1, groupId: 7 },
      b: { depositionId: 2, groupId: 3 },
      exchangeA: 72, // the exact parts behind the score, kept as the source references
      exchangeB: 31,
      score: 1,
      foundBy: "both",
    });
  });

  it("gives the same pair, score and parts whichever direction found it", () => {
    const one = rankPairs([{ source: 80, target: 40 }], parts, weights);
    const other = rankPairs([{ source: 40, target: 80 }], parts, weights);
    expect({ ...one[0], foundBy: null }).toEqual({ ...other[0], foundBy: null });
    expect([one[0].foundBy, other[0].foundBy]).toEqual(["a", "b"]);
  });

  it("ranks by score, the same however the matches arrive", () => {
    const matches = [
      { source: 80, target: 40 },
      { source: 71, target: 32 },
      { source: 31, target: 72 },
    ];
    const ranked = rankPairs(matches, parts, weights);
    expect(ranked.map((p) => [p.rank, p.a.groupId, p.b.groupId, p.score])).toEqual([
      [1, 7, 3, 1],
      [2, 8, 4, 1],
    ]);
    for (const shuffled of [[...matches].reverse(), [matches[1], matches[0], matches[2]]]) {
      expect(rankPairs(shuffled, parts, weights)).toEqual(ranked);
    }
  });

  it("fails loudly on a match whose part has no terms, rather than dropping it", () => {
    expect(() => rankPairs([{ source: 71, target: 999 }], parts, weights)).toThrow("no terms for exchange part 999");
  });

  it("returns nothing for no matches", () => {
    expect(rankPairs([], parts, weights)).toEqual([]);
  });
});
