import { describe, expect, it } from "vitest";
import { HYBRID_PER_EXCHANGE_CAP, hybridRetrievalVersion, unionCandidates, type TopicPair, type RankedPair } from "../../server/src/retrieve";

const logical = (n: number) => ({ a: { depositionId: 1, groupId: n }, b: { depositionId: 2, groupId: n } });
const pathA = (n: number, rank: number, over: Partial<TopicPair> = {}): TopicPair => ({ rank, signal: "same_topic", comparable: false, ...logical(n), exchangeA: 10 + n, exchangeB: 20 + n, cardA: n, cardB: n, topicIds: [n], sharedEntities: [], eventOverlap: 0, cardPairs: 1, exclusion: null, ...over });
const pathB = (n: number, rank: number): RankedPair => ({ rank, score: 1, ...logical(n), exchangeA: 30 + n, exchangeB: 40 + n, sharedTerms: [], foundBy: "both" });
const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const noCap = { perExchangeCap: 1000 };

describe("unionCandidates", () => {
  it("dedupes on the logical pair and records both paths, billing one slot", () => {
    const { candidates, counts } = unionCandidates({ topics: [pathA(1, 1)], fulltext: [pathB(1, 4)] }, { capacity: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sources: ["topics", "fulltext"], ranks: { topics: 1, fulltext: 4 }, status: "selected", topicIds: [1] });
    expect(candidates[0].evidence.map((e) => e.path)).toEqual(["topics", "fulltext"]);
    expect(counts).toMatchObject({ both: 1, pathA: 0, pathB: 0, selected: 1 });
  });

  it("allocates 60/40 at capacity", () => {
    const { counts } = unionCandidates({ topics: many(1, 50).map((n, i) => pathA(n, i + 1)), fulltext: many(100, 50).map((n, i) => pathB(n, i + 1)) }, { capacity: 10, ...noCap });
    expect(counts.selectedBy).toEqual({ path_a: 6, path_b: 4 });
    expect(counts).toMatchObject({ targets: { path_a: 6, path_b: 4 }, redistributed: 0, deferred: 90 });
  });

  it("stays near 60/40 at every point, so an early budget stop can't starve Path B", () => {
    const { candidates } = unionCandidates({ topics: many(1, 50).map((n, i) => pathA(n, i + 1)), fulltext: many(100, 50).map((n, i) => pathB(n, i + 1)) }, { capacity: 20, ...noCap });
    const first = candidates.slice(0, 5).map((c) => c.selectedBy);
    expect(first).toContain("path_b");
    for (const n of [5, 10, 15, 20]) expect(candidates.slice(0, n).filter((c) => c.selectedBy === "path_b").length).toBeGreaterThanOrEqual(Math.floor(n * 0.4));
  });

  it("gives unused capacity to the other path, both ways", () => {
    const short = unionCandidates({ topics: [pathA(1, 1)], fulltext: many(100, 20).map((n, i) => pathB(n, i + 1)) }, { capacity: 10, ...noCap });
    expect(short.counts.selectedBy).toEqual({ path_a: 1, path_b: 9 });
    expect(short.counts.redistributed).toBe(5);
    const other = unionCandidates({ topics: many(1, 20).map((n, i) => pathA(n, i + 1)), fulltext: [pathB(100, 1)] }, { capacity: 10, ...noCap });
    expect(other.counts.selectedBy).toEqual({ path_a: 9, path_b: 1 });
  });

  it("with no cards at all, Path B takes every slot", () => {
    expect(unionCandidates({ fulltext: many(100, 5).map((n, i) => pathB(n, i + 1)) }, { capacity: 3, ...noCap }).counts.selectedBy).toEqual({ path_a: 0, path_b: 3 });
  });

  it("respects each path's own order, with no fusion", () => {
    const { candidates } = unionCandidates({ topics: [pathA(2, 2), pathA(1, 1)] }, { capacity: 1 });
    expect(candidates[0].ranks.topics).toBe(1);
  });

  it("loses nothing: every input is selected or deferred, with its reason", () => {
    const pool = unionCandidates({ topics: [pathA(1, 1), pathA(3, 2), pathA(2, 3, { exclusion: "side_not_answered" })], fulltext: [pathB(4, 1)] }, { capacity: 2 });
    const byStatus = Object.fromEntries(pool.candidates.map((c) => [c.a.groupId, [c.status, c.deferredReason]]));
    expect(byStatus).toEqual({ 1: ["selected", null], 4: ["selected", null], 3: ["deferred", "budget"], 2: ["deferred", "side_not_answered"] });
    expect(pool.counts.excluded).toBe(0);
  });

  it("a model's card label never rules a pair out: with capacity to spare it is assessed", () => {
    const { candidates } = unionCandidates({ topics: [pathA(1, 1, { exclusion: "not_the_witness_assertion" })] }, { capacity: 5 });
    expect(candidates[0]).toMatchObject({ status: "selected", selectedBy: "path_a" });
  });

  it("Path A's cards can't exclude a pair Path B found in the testimony", () => {
    const { candidates } = unionCandidates({ topics: [pathA(1, 1, { exclusion: "side_not_answered" })], fulltext: [pathB(1, 1)] }, { capacity: 1 });
    expect(candidates[0]).toMatchObject({ status: "selected", exclusionReason: null });
  });

  it("defers past the per-exchange cap, with that reason", () => {
    const sameA = (n: number) => pathA(n, n, { a: { depositionId: 1, groupId: 1 } });
    const { candidates } = unionCandidates({ topics: [sameA(1), sameA(2), sameA(3), pathA(4, 4)] }, { capacity: 3, perExchangeCap: 2 });
    expect(candidates.map((c) => [c.a.groupId, c.status])).toEqual([[1, "selected"], [1, "selected"], [4, "selected"], [1, "deferred"]]);
    expect(candidates[3].deferredReason).toBe("cap");
  });

  it("spare capacity goes to capped candidates rather than sitting empty", () => {
    const sameA = (n: number) => pathA(n, n, { a: { depositionId: 1, groupId: 1 } });
    const { candidates } = unionCandidates({ topics: [sameA(1), sameA(2), sameA(3)] }, { capacity: 10, perExchangeCap: 2 });
    expect(candidates.every((c) => c.status === "selected")).toBe(true);
  });

  it("is reproducible, and a share outside 0 to 1 is refused", () => {
    const input = { topics: many(1, 9).map((n, i) => pathA(n, i + 1)), fulltext: many(5, 9).map((n, i) => pathB(n, i + 1)) };
    expect(unionCandidates(input, { capacity: 6 })).toEqual(unionCandidates(input, { capacity: 6 }));
    expect(() => unionCandidates({}, { capacity: 1, pathAShare: 1 })).toThrow();
  });

  it("hybrid's cap is 5", () => {
    expect(HYBRID_PER_EXCHANGE_CAP).toBe(5);
    const same = many(1, 8).map((n, i) => pathA(n, i + 1, { a: { depositionId: 1, groupId: 1 } }));
    expect(unionCandidates({ topics: same }, { capacity: 5 }).counts.selected).toBe(5);
    expect(hybridRetrievalVersion({ extractorVersion: "x", pathBMode: "y" })).toContain("cap:5");
  });

  it("a change to any part of the configuration is a new retrieval version", () => {
    const base = { extractorVersion: "cards-v1+h", pathBMode: "rare_terms" };
    const v = hybridRetrievalVersion(base);
    expect(hybridRetrievalVersion(base)).toBe(v);
    for (const change of [{ extractorVersion: "cards-v2+h" }, { pathBMode: "all_terms" }, { pathAShare: 0.5 }, { perExchangeCap: 7 }]) expect(hybridRetrievalVersion({ ...base, ...change })).not.toBe(v);
  });
});
