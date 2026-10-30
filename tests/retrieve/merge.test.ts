import { describe, expect, it } from "vitest";
import { mergeCandidates, RRF_K, selectCandidates, type ClaimPair, type RankedPair } from "../../server/src/retrieve";

const L = (depositionId: number, groupId: number) => ({ depositionId, groupId });

const fulltext = (rank: number, a: [number, number], b: [number, number], parts: [number, number]): RankedPair => ({
  rank,
  score: 0.5,
  a: L(...a),
  b: L(...b),
  exchangeA: parts[0],
  exchangeB: parts[1],
  sharedTerms: ["outsourc", "softwar"],
  foundBy: "both",
});

const claims = (rank: number, a: [number, number], b: [number, number], parts: [number, number]): ClaimPair => ({
  rank,
  signal: "opposite_polarity",
  a: L(...a),
  b: L(...b),
  exchangeA: parts[0],
  exchangeB: parts[1],
  claimA: 900 + rank,
  claimB: 950 + rank,
  predicate: "buy",
  sharedEntities: ["peoplesoft"],
  claimPairs: 1,
});

describe("mergeCandidates", () => {
  it("scores by reciprocal rank fusion and keeps each path's rank and exact evidence, including different parts", () => {
    const merged = mergeCandidates({
      claims: [claims(1, [1, 7], [2, 3], [71, 31])],
      fulltext: [fulltext(1, [1, 9], [2, 4], [90, 40]), fulltext(2, [1, 7], [2, 3], [72, 31])],
    });
    expect(merged.map((c) => [c.rank, c.a.groupId, c.b.groupId, c.sources])).toEqual([
      [1, 7, 3, ["claims", "fulltext"]],
      [2, 9, 4, ["fulltext"]],
    ]);
    const both = merged[0];
    expect(both.rrfScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2));
    expect(both.ranks).toEqual({ claims: 1, fulltext: 2 });
    // The paths found the same logical pair through different parts of a split answer; both kept.
    expect(both.evidence.map((e) => [e.path, e.exchangeA, e.exchangeB])).toEqual([
      ["claims", 71, 31],
      ["fulltext", 72, 31],
    ]);
    expect(both.evidence[0]).toMatchObject({ claimA: 901, claimB: 951, signal: "opposite_polarity" });
  });

  it("works with one path alone, so each path can be measured on its own", () => {
    expect(mergeCandidates({ claims: [claims(1, [1, 7], [2, 3], [71, 31])] }).map((c) => c.sources)).toEqual([["claims"]]);
    expect(mergeCandidates({ fulltext: [] })).toEqual([]);
  });

  it("breaks score ties by logical exchange, so the order is stable", () => {
    const merged = mergeCandidates({ fulltext: [fulltext(1, [1, 9], [2, 4], [1, 2])], claims: [claims(1, [1, 2], [2, 8], [3, 4])] });
    expect(merged.map((c) => c.a.groupId)).toEqual([2, 9]);
  });
});

describe("selectCandidates", () => {
  it("caps each logical exchange and fills the budget in rank order, deferring the rest with a reason", () => {
    const merged = mergeCandidates({
      fulltext: [
        fulltext(1, [1, 1], [2, 1], [1, 1]),
        fulltext(2, [1, 1], [2, 2], [1, 2]),
        fulltext(3, [1, 1], [2, 3], [1, 3]), // exchange 1:1 already in two selected pairs
        fulltext(4, [1, 2], [2, 4], [2, 4]),
        fulltext(5, [1, 3], [2, 5], [3, 5]), // over the budget of 3
      ],
    });
    const { selected, deferred } = selectCandidates(merged, { budget: 3, perExchangeCap: 2 });
    expect(selected.map((c) => c.rank)).toEqual([1, 2, 4]);
    expect(deferred.map((c) => [c.rank, c.reason])).toEqual([
      [3, "cap"],
      [5, "budget"],
    ]);
  });
});
