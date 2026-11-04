import { describe, expect, it } from "vitest";
import { evaluateScreening, projectCost } from "../../server/src/eval/screeningBenchmark";
import type { CandidatePool, FrozenItem } from "../../server/src/retrieve/frozen";
import type { PacketSet } from "../../server/src/retrieve/grouping";
import { accountFor, ScreeningResultSchema, SCREENING_CONTRACT_VERSION } from "../../server/src/screen/contract";
import { coverageOrder, screen } from "../../server/src/screen/strategies";

const item = (key: string, session: string, witness: string, answer: string): FrozenItem => ({
  key, document: key.split("#")[0], witness, session, groupId: 1, positions: ["1:1"], sourceHash: `h-${key}`,
  question: "Q. What happened at the meeting on Tuesday?", answer, context: "",
});
const ITEMS = [
  item("a#1", "s1", "Ann", "I arrived at 9 o'clock with Oduya in the blue car."),
  item("a#2", "s1", "Ann", "I never met Oduya that week."),
  item("a#3", "s1", "Ann", "The lunch was at the Ritz."),
  item("b#1", "s2", "Ann", "I arrived at 11 o'clock with Oduya in the blue car."),
  item("b#2", "s2", "Ann", "I met Oduya on Tuesday."),
  item("c#1", "s3", "Bob", "The lunch was at the Savoy."),
];
const cand = (a: string, b: string, fused: number, ranks: Record<string, [number | null, number | null]>) => ({ a, b, fused, ranks });
const POOL: CandidatePool = {
  name: "t", perItem: 2, paths: ["A_fulltext", "E_minilm_qac_s"],
  candidates: [
    cand("a#1", "b#1", 0.05, { A_fulltext: [1, 1], E_minilm_qac_s: [1, 1] }),
    cand("a#2", "b#2", 0.03, { A_fulltext: [2, null], E_minilm_qac_s: [null, 3] }),
    cand("a#1", "b#2", 0.02, { A_fulltext: [3, null], E_minilm_qac_s: [null, null] }),
    cand("a#3", "c#1", 0.01, { A_fulltext: [null, 5], E_minilm_qac_s: [8, null] }),
    cand("a#2", "a#3", 0.01, { A_fulltext: [1, 1], E_minilm_qac_s: [null, null] }), // same session: uncovered
  ],
};
const SET: PacketSet = {
  name: "t", source: "t", settings: {}, tokenAssumption: "",
  packets: [
    { id: "issue-1", issue: "", items: ["a#1", "b#1"], pairs: [["a#1", "b#1"]], inputTokens: 3000 },
    { id: "star-2", issue: "", items: ["a#1", "a#2", "b#2"], pairs: [["a#2", "b#2"], ["a#1", "b#2"]], inputTokens: 3100 },
    { id: "issue-3", issue: "", items: ["a#3", "c#1"], pairs: [["a#3", "c#1"]], inputTokens: 2900 },
  ],
  uncovered: [{ a: "a#2", b: "a#3", reason: "same session" }],
};

describe("screening contract", () => {
  const ok = screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 1, consolidate: false })[0];
  it("accepts a strategy's result and rejects verdict-like or unknown keys", () => {
    expect(ScreeningResultSchema.safeParse(ok).success).toBe(true);
    expect(ScreeningResultSchema.safeParse({ ...ok, confidence: 0.9 }).success).toBe(false);
    expect(ScreeningResultSchema.safeParse({ ...ok, signals: { contradictionProbability: 0.7 } }).success).toBe(false);
    expect(ScreeningResultSchema.safeParse({ ...ok, contract: "screen-contract-v0" }).success).toBe(false);
  });
  it("ties consolidated status, target and null rank together", () => {
    expect(ScreeningResultSchema.safeParse({ ...ok, status: "consolidated" }).success).toBe(false);
    expect(ScreeningResultSchema.safeParse({ ...ok, status: "consolidated", consolidatedInto: "x", rank: null }).success).toBe(true);
  });
  it("accounts for every pool pair once and flags a missing result or a lost pair", () => {
    const results = screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 2, consolidate: false });
    const acc = accountFor(POOL, SET, results);
    expect(acc).toMatchObject({ poolPairs: 5, packetedPairs: 4, uncoveredPairs: 1, packets: 3, prioritized: 2, deferred: 1, consolidated: 0, problems: [] });
    expect(accountFor(POOL, SET, results.slice(1)).problems.length).toBeGreaterThan(0);
    expect(accountFor(POOL, { ...SET, uncovered: [] }, results).problems.join()).toMatch(/accounted 0 times/);
  });
});

describe("screen", () => {
  it("prioritizes exactly the budget, defers the rest with a reason that is not a finding, ranks 1..n", () => {
    const r = screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 1, consolidate: false });
    expect(r.map((x) => x.status)).toEqual(["prioritized", "deferred", "deferred"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
    for (const x of r.filter((x) => x.status === "deferred")) expect(x.reason).toMatch(/not a finding of no contradiction/);
    expect(r.every((x) => x.adjudication === "not_started" && x.contract === SCREENING_CONTRACT_VERSION)).toBe(true);
  });
  it("puts the pair every path retrieves both ways first, and is deterministic", () => {
    const a = screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 0, consolidate: false });
    expect(a[0].packetId).toBe("issue-1");
    expect(a[0].signals).toMatchObject({ bestPaths: 2, bestMutualPaths: 2 });
    expect(screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 0, consolidate: false })).toEqual(a);
    expect(screen(SET, POOL, ITEMS, { strategy: "baseline", budget: 0, consolidate: false }).map((x) => x.packetId)).toEqual(["issue-1", "star-2", "issue-3"]);
  });
  it("records provenance: sessions, witnesses, item hashes and original pairs", () => {
    const star = screen(SET, POOL, ITEMS, { strategy: "fused", budget: 3, consolidate: false }).find((x) => x.packetId === "star-2")!;
    expect(star.sessions).toEqual(["s1", "s2"]);
    expect(star.items.map((i) => i.sourceHash)).toEqual(["h-a#1", "h-a#2", "h-b#2"]);
    expect(star.pairs).toEqual([["a#2", "b#2"], ["a#1", "b#2"]]);
  });
  it("consolidates a packet sharing half its passages in the same sessions, never one of other sessions", () => {
    const r = screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 5, consolidate: true });
    const star = r.find((x) => x.packetId === "star-2")!;
    expect(star).toMatchObject({ status: "consolidated", consolidatedInto: "issue-1", rank: null });
    expect(r.find((x) => x.packetId === "issue-3")!.status).toBe("prioritized"); // other sessions: never folded
    expect(accountFor(POOL, SET, r).problems).toEqual([]);
    // Too small a bound: the union no longer fits, so nothing is folded.
    expect(screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 5, consolidate: true, maxItems: 2 }).every((x) => x.status !== "consolidated")).toBe(true);
  });
  it("rejects a packet item missing from the corpus and a bad budget", () => {
    expect(() => screen(SET, POOL, ITEMS.slice(1), { strategy: "baseline", budget: 1, consolidate: false })).toThrow(/not in the corpus/);
    expect(() => screen(SET, POOL, ITEMS, { strategy: "baseline", budget: -1, consolidate: false })).toThrow(/budget/);
  });
});

describe("coverageOrder", () => {
  it("takes turns between session pairs instead of draining the strongest one", () => {
    const e = (id: string, bucket: string, priority: number, items: string[]) => ({ id, bucket, priority, items });
    const order = coverageOrder([e("x1", "X", 9, ["1"]), e("x2", "X", 8, ["2"]), e("x3", "X", 7, ["3"]), e("y1", "Y", 1, ["4"])]);
    expect(order).toEqual(["x1", "y1", "x2", "x3"]);
  });
  it("prefers a packet with unread passages within a session pair", () => {
    const e = (id: string, priority: number, items: string[]) => ({ id, bucket: "X", priority, items });
    expect(coverageOrder([e("a", 5, ["1", "2"]), e("b", 4.9, ["1", "2"]), e("c", 3, ["3", "4"])])).toEqual(["a", "c", "b"]);
  });
});

describe("evaluateScreening", () => {
  const byKey = new Map(ITEMS.map((i) => [i.key, i]));
  const labels = [
    { id: "T", category: "review_worthy", source: "", left: ["a#2"], right: ["b#2"] },
    { id: "K", category: "control", source: "", left: ["a#3"], right: ["c#1"] },
    { id: "M", category: "review_worthy", source: "", left: ["a#3"], right: ["b#1"] }, // in no packet
  ];
  it("counts a label reached at the rank of the packet holding both sides, consolidated at its target's rank", () => {
    const plain = evaluateScreening(screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 0, consolidate: false }), labels, byKey, [1, 3]);
    const folded = evaluateScreening(screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 0, consolidate: true }), labels, byKey, [1]);
    expect(plain.labels.find((l) => l.id === "M")!.firstRank).toBeNull();
    expect(plain.budgets[1].targets).toEqual({ reached: 1, of: 2 });
    expect(plain.budgets[1].controls).toEqual({ reached: 1, of: 1 });
    expect(folded.labels.find((l) => l.id === "T")!.firstRank).toBe(1);
    expect(folded.budgets[0].targets.reached).toBe(1);
    expect(plain.problems).toEqual([]);
  });
  it("counts a label reached when its sides are split between a packet and one folded into it", () => {
    // a#1 is only in issue-1, b#2 only in star-2 (folded into issue-1): read together in one call.
    const split = [{ id: "S", category: "review_worthy", source: "", left: ["b#1"], right: ["a#2"] }];
    const folded = evaluateScreening(screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 0, consolidate: true }), split, byKey, [1]);
    expect(folded.labels[0].firstRank).toBe(1);
    const plain = evaluateScreening(screen(SET, POOL, ITEMS, { strategy: "deterministic", budget: 0, consolidate: false }), split, byKey, [3]);
    expect(plain.labels[0].firstRank).toBeNull();
  });
  it("flags an item whose source hash no longer matches the corpus", () => {
    const changed = new Map(byKey);
    changed.set("a#1", { ...byKey.get("a#1")!, sourceHash: "new" });
    expect(evaluateScreening(screen(SET, POOL, ITEMS, { strategy: "baseline", budget: 0, consolidate: false }), labels, changed, [1]).problems.join()).toMatch(/provenance differs/);
  });
  it("prices output per listed pair and caches the shared prefix", () => {
    const three = Array(3).fill({ passageTokens: 1000, pairs: 2 });
    expect(projectCost(three, false)).toBeGreaterThan(projectCost(three)); // the prefix is written once, then read cheaply
    expect(projectCost([{ passageTokens: 0, pairs: 10 }])).toBeGreaterThan(projectCost([{ passageTokens: 0, pairs: 1 }]));
  });
});
