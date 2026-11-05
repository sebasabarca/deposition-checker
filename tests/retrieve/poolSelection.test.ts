import { describe, expect, it } from "vitest";
import { buildPool, pairKey, type PathNeighbours } from "../../server/src/retrieve/frozen";

// q's neighbours: x1..x6 in session X (ranked first), y1, y2 in session Y. Two paths agree except path 2 ranks y1 first.
const path = (name: string, list: string[]): PathNeighbours => ({ path: name, depth: 100, neighbours: { q: list.map((k, i) => [k, 1 - i / 100]) } });
const p1 = path("p1", ["x1", "x2", "x3", "x4", "x5", "x6", "y1", "y2"]);
const p2 = path("p2", ["x1", "x2", "x3", "x4", "x5", "x6", "y1", "y2"]);
const p3 = path("p3", ["y2", "x1", "x2", "x3", "x4", "x5", "x6", "y1"]);
const session = (k: string) => k[0];
const partners = (pool: ReturnType<typeof buildPool>) => pool.candidates.map((c) => (c.a === "q" ? c.b : c.a)).sort();

describe("buildPool selection", () => {
  it("without a selection keeps the plain fused top perItem (unchanged behaviour)", () => {
    expect(partners(buildPool("t", [p1, p2], 3))).toEqual(["x1", "x2", "x3"]);
  });
  it("a per-group quota adds each other group's best partners, bounded by perGroup", () => {
    expect(partners(buildPool("t", [p1, p2], 3, { quota: { groupOf: session, perGroup: 1 } }))).toEqual(["x1", "x2", "x3", "x4", "y1"]);
  });
  it("the relevance floor admits a quota partner only near the item's own cut", () => {
    // y1's fused score is far below x3's (the 3rd partner): at 0.97 it stays out (0.94 of x3), while x4 (0.98 of x3) enters.
    expect(partners(buildPool("t", [p1, p2], 3, { quota: { groupOf: session, perGroup: 1, minShare: 0.97 } }))).toEqual(["x1", "x2", "x3", "x4"]);
  });
  it("perPath adds each path's own best partner not yet chosen", () => {
    const got = partners(buildPool("t", [p1, p2, p3], 3, { perPath: 1 }));
    expect(got).toContain("y2"); // p3's best
    expect(got.length).toBeLessThanOrEqual(3 + 3);
    expect(new Set(buildPool("t", [p1, p2, p3], 3, { perPath: 1 }).candidates.map((c) => pairKey(c.a, c.b))).size).toBe(got.length);
  });
});
