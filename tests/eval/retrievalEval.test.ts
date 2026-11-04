import { describe, expect, it } from "vitest";
import type { CrossLabelFile } from "../../server/src/eval/crossLabels";
import { caseOfDocument, diffCorpora, withinCase, checkDuplicates, checkItemText, checkManifest, checkSegmentation, checkSessions, checkSides, collectPaths, evaluatePool, fixtureFromCrossLabels, heldOutPairs, kindOf, locatePhrase, PacketSetSchema, evaluatePackets, poolBurden, poolContribution, rankPairs, targetClassOf, unlabelledSample } from "../../server/src/eval/retrievalEval";
import { buildPool, type FrozenItem, type FrozenPair, type PathNeighbours, type PathRankings, type Ranked } from "../../server/src/retrieve/frozen";

// Six items in three sessions: a1 a2 (session A), b1 b2 (B), c1 c2 (C).
const item = (key: string, session: string, positions: string[], answer = "yes it was"): FrozenItem => ({ key, document: session.toLowerCase(), witness: session, session, groupId: 0, positions, sourceHash: key, question: "was it", answer, context: "" });
const ITEMS = [item("a1", "A", ["0:1", "0:2"]), item("a2", "A", ["0:3"]), item("b1", "B", ["0:1"]), item("b2", "B", ["0:2", "0:3"]), item("c1", "C", ["0:1"]), item("c2", "C", ["0:2"])];
const others = (q: string) => ITEMS.filter((i) => i.session !== ITEMS.find((x) => x.key === q)!.session).map((i) => i.key);
// path P ranks b2 first from a1; path Q ranks it third.
const listP = (q: string): Ranked[] => (q === "a1" ? ["b2", "b1", "c1", "c2"] : others(q)).map((k, i) => [k, 1 - i / 10]);
const listQ = (q: string): Ranked[] => (q === "a1" ? ["c1", "c2", "b2", "b1"] : [...others(q)].reverse()).map((k, i) => [k, 1 - i / 10]);
const nb = (path: string, f: (q: string) => Ranked[], depth = 4): PathNeighbours => ({ path, depth, neighbours: Object.fromEntries(ITEMS.map((i) => [i.key, f(i.key).slice(0, depth)])) });
const TARGET: FrozenPair = { id: "T", category: "review_worthy", source: "test", left: ["a1"], right: ["b2"] };
const CONTROL: FrozenPair = { id: "N", category: "no_conflict", source: "test", left: ["a2"], right: ["c2"] };

describe("retrieval evaluator", () => {
  it("sorts categories into targets, controls and exploratory pairs", () => {
    expect(["review_worthy", "conflict", "conflict_needs_context", "control", "no_conflict", "exploratory", "insufficient_evidence"].map(kindOf)).toEqual(["target", "target", "target", "control", "control", "exploratory", "unknown"]);
    expect(["conflict", "conflict_needs_context", "review_worthy", "no_conflict"].map(targetClassOf)).toEqual(["direct", "needs_context", "unclassified", null]);
  });

  // A hand-ordered pool: x (unlabelled), the control, y (unlabelled), the target. Every item is 9 chars = 3 tokens.
  const ORDERED = { name: "r", perItem: 1, paths: [], candidates: [["a1", "c1"], ["a2", "c2"], ["b1", "c2"], ["a1", "b2"]].map(([a, b]) => ({ a, b, fused: 0, ranks: {} })) };
  const ITEM_MAP = new Map(ITEMS.map((i) => [i.key, { ...i, question: "was it", answer: "abc" }]));

  it("counts the review burden and projected tokens to reach each labelled pair in pool order", () => {
    const report = evaluatePool(ORDERED, [TARGET, CONTROL]);
    const b = poolBurden(ORDERED, report, [TARGET, CONTROL], ITEM_MAP, 10);
    expect(b.calls).toBe(4);
    expect(b.tokens).toBe(4 * (3 + 3 + 10));
    expect(b.unlabelled).toBe(2);
    expect(b.reach).toEqual([
      { id: "N", kind: "control", category: "no_conflict", reviewed: 2, unlabelledAhead: 1, labelledAhead: 0, tokensToReach: 32 },
      { id: "T", kind: "target", category: "review_worthy", reviewed: 4, unlabelledAhead: 2, labelledAhead: 1, tokensToReach: 64 },
    ]);
    expect(b.targetsInOrder).toEqual([4]);
    expect(b.bySession.map((r) => [r.key, r.candidates, r.counts.target, r.counts.control])).toEqual([["A x C", 2, [0, 0], [1, 1]], ["A x B", 1, [1, 1], [0, 0]], ["B x C", 1, [0, 0], [0, 0]]]);
    expect(report.classes).toEqual({ unclassified: [1, 1] });
  });

  it("restricts a pool to one case per candidate, keeping its order", () => {
    const caseOf = caseOfDocument(/^(a|b)/); // documents a and b are case "a"/"b"; c is its own
    expect(caseOf("abc")).toBe("a");
    expect(caseOf("c")).toBe("c");
    const one = caseOfDocument(/^[ab]/); // a and b share no case either: whole match differs
    expect(withinCase(ORDERED, ITEM_MAP, one).candidates).toEqual([]);
    const ab = caseOfDocument(/^(?:a|b)()/); // empty first group: a and b are one case, c its own
    expect(withinCase(ORDERED, ITEM_MAP, ab).candidates.map((c) => `${c.a}${c.b}`)).toEqual(["a1b2"]);
  });

  it("diffs two corpus versions item by item and maps labelled sides", () => {
    const before = [ITEMS[0], ITEMS[1], { ...ITEMS[2], answer: "no" }, item("whole", "C", ["0:1", "0:2"])];
    const excluded = { ...item("c1", "C", ["0:1"]), eligibility: { class: "cover_or_signature", eligible: false, reason: "" } };
    const after = [ITEMS[0], ITEMS[2], item("c2", "C", ["0:2"])];
    const d = diffCorpora(before, after, [excluded], [TARGET, { ...CONTROL, right: ["whole"] }], [TARGET, { ...CONTROL, right: ["c2"] }, { ...TARGET, id: "X" }]);
    expect(d.totals).toEqual({ before: 4, after: 3, same: 1, changed: 1, removed: 2, added: 1, excludedAfter: 1 });
    expect(d.removedFate).toEqual({ "no longer read": 1, "re-segmented, partly excluded": 1 });
    expect(d.pairs.map((p) => p.status)).toEqual(["unchanged", "remapped", "added"]);
    expect(d.pairs[1].right).toEqual([["whole"], ["c2"]]);
  });

  it("evaluates a packet set: sides together, listed pairs, sizes, tokens and problems", () => {
    const DIRECT: FrozenPair = { id: "D", category: "conflict", source: "test", left: ["b1"], right: ["c1"] };
    const set = {
      name: "g", source: "pool", settings: {}, tokenAssumption: "stated",
      packets: [
        { id: "p1", issue: "i", items: ["a2", "c2", "b1"], pairs: [["a2", "c2"], ["b1", "c2"]] as [string, string][], inputTokens: 100 },
        { id: "p2", issue: "j", items: ["a1", "b2", "a2"], pairs: [["a1", "a2"], ["a1", "c1"]] as [string, string][], inputTokens: 50 },
      ],
      uncovered: [{ a: "b1", b: "c1", reason: "over budget" }],
    };
    const r = evaluatePackets(PacketSetSchema.parse(set), [TARGET, CONTROL, DIRECT], ITEM_MAP, 10);
    expect(r.calls).toBe(2);
    expect(r.statedTokens).toBe(150);
    expect(r.projectedTokens).toBe(2 * (9 + 10));
    expect(r.pairByPairTokens).toBe(4 * 16);
    expect(r.itemsPerPacket).toEqual({ min: 3, median: 3, max: 3, total: 6 });
    const t = r.pairs.find((p) => p.id === "T")!;
    expect([t.together, t.listed, t.firstPacket, t.tokensToReach]).toEqual([["p2"], [], 2, 38]);
    expect(r.pairs.find((p) => p.id === "N")!.listed).toEqual(["p1"]);
    expect(r.pairs.find((p) => p.id === "D")!.uncovered).toEqual(["over budget"]);
    expect(r.together.target).toEqual([1, 2]);
    expect(r.classes).toEqual({ unclassified: [1, 1], direct: [0, 1] });
    expect(r.unlabelledListedPairs).toBe(3);
    expect(r.problems.map((p) => p.detail)).toEqual(["p2: 1 listed pair(s) name an item the packet does not hold", "p2: 1 listed pair(s) join two items of one session"]);
    expect(PacketSetSchema.safeParse({ ...set, packets: [{ id: "x" }] }).success).toBe(false);
  });

  it("ranks a pair in both directions per path, fused, and with each path removed", () => {
    const paths = collectPaths([], [nb("P", listP), nb("Q", listQ)]);
    const [t] = rankPairs([TARGET], paths);
    expect(t.paths.P.ab).toEqual({ rank: 1, from: "depth" });
    expect(t.paths.Q.ab).toEqual({ rank: 3, from: "depth" });
    expect(t.paths.P.ba.rank).toBe(1); // b2's list from P: a1 first
    expect(t.fused.ab).toBe(1); // b2 and c1 both score 1/61 + 1/63; the tie goes to the smaller key
    expect(t.ablation.P.ab).toBe(3);
    expect(t.ablation.Q.ab).toBe(1);
    expect(t.kind).toBe("target");
  });

  it("tells a rank beyond the depth from one never retrieved, and prefers a full ranking", () => {
    const shallow = collectPaths([], [nb("P", listQ, 2)]);
    expect(rankPairs([TARGET], shallow)[0].paths.P.ab).toEqual({ rank: null, from: "depth" });
    const full: PathRankings = { path: "P", rankings: { a1: [["c1", 1]] } };
    expect(rankPairs([TARGET], collectPaths([full], [nb("P", listQ, 2)]))[0].paths.P.ab).toEqual({ rank: null, from: "full" });
    expect(rankPairs([TARGET], collectPaths([], []))[0].paths).toEqual({});
  });

  it("finds where a pool holds each pair, by pool rank and per-item rank, and counts budgets by kind", () => {
    const pool = buildPool("p", [nb("P", listP), nb("Q", listQ)], 2);
    const r = evaluatePool(pool, [TARGET, CONTROL], new Map(ITEMS.map((i) => [i.key, i.session])));
    expect(r.crossSession).toBe(true);
    const t = r.pairs.find((p) => p.id === "T")!;
    expect(t.held).toBe(true);
    expect(t.perItemRank).toBe(1);
    expect(r.perItemBudgets[1].target).toEqual([1, 1]);
    expect(r.perItemBudgets[1].control[1]).toBe(1);
    expect(Object.keys(r.sizeBudgets).map(Number)).toEqual([pool.candidates.length]);
  });

  it("flags a pool candidate inside one session", () => {
    const pool = { name: "bad", perItem: 1, paths: [], candidates: [{ a: "a1", b: "a2", fused: 1, ranks: {} }] };
    expect(evaluatePool(pool, [], new Map(ITEMS.map((i) => [i.key, i.session]))).crossSession).toBe(false);
  });

  it("rebuilds a fused pool without each path, and refuses a pool it cannot reproduce", () => {
    const paths = collectPaths([], [nb("P", listP), nb("Q", listQ)]);
    const pool = buildPool("p", [nb("P", listP), nb("Q", listQ)], 1);
    const c = poolContribution(pool, paths, [TARGET]);
    expect(c.reproducible).toBe(true);
    expect(c.ablations.find((a) => a.path === "Q")!.lostPairs).toEqual([]);
    expect(poolContribution({ ...pool, candidates: pool.candidates.slice(1) }, paths, [TARGET]).reproducible).toBe(false);
  });

  it("samples the best candidates that join no labelled pair", () => {
    const pool = buildPool("p", [nb("P", listP)], 2);
    const s = unlabelledSample(pool, [TARGET], new Map(ITEMS.map((i) => [i.key, i])), 3);
    expect(s).toHaveLength(3);
    expect(s.every((c) => !(c.a === "a1" && c.b === "b2"))).toBe(true);
    expect(s[0].excerptA).toBe("yes it was");
  });

  it("checks the manifest, the sides, sessions, duplicates and item text", () => {
    expect(checkManifest({ "x.json": "1", "y.json": "2" }, { "x.json": "1", "y.json": "3", "z.json": "4" }).map((p) => p.detail)).toEqual([expect.stringMatching(/^y.json: SHA-256 3/), "z.json is not in the manifest"]);
    const fixture = { items: [{ id: "T", category: "review_worthy", sides: [{ document: "a", from: "0:2", to: "0:3", search: "" }, { document: "b", from: "0:3", to: "0:3", search: "" }] }] };
    expect(checkSides(ITEMS, fixture, { corpus: "t", pairs: [{ ...TARGET, left: ["a1", "a2"] }] })).toEqual([]);
    expect(checkSides(ITEMS, fixture, { corpus: "t", pairs: [TARGET] })).toHaveLength(1);
    expect(checkSessions(ITEMS, [{ ...TARGET, right: ["a2"] }], collectPaths([], [nb("P", listP)]))).toHaveLength(1);
    expect(checkSessions(ITEMS, [TARGET], collectPaths([], [{ path: "X", depth: 1, neighbours: { a1: [["a2", 1]] } }]))[0].detail).toMatch(/own session/);
    const long = "w ".repeat(50);
    expect(checkDuplicates([item("a1", "A", ["0:1"], long), item("b1", "B", ["0:1"], long)], { a: { sha256: "s" }, b: { sha256: "s" } }).map((p) => p.detail)).toEqual([expect.stringMatching(/share SHA-256/), expect.stringMatching(/^1 substantive answer groups/)]);
    expect(checkItemText(ITEMS[0], new Map([["0:1", "Q. Was it"], ["0:2", "A. Yes, it was."]]))).toBeNull();
    expect(checkItemText(ITEMS[0], new Map([["0:1", "Q. Was it"], ["0:2", "A. No."]]))).toMatch(/source lines: yes$/);
    expect(checkItemText(ITEMS[0], new Map([["0:1", "x"]]))).toMatch(/0:2 are not in the source/);
  });

  it("flags a document read as one exchange", () => {
    const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `0:${from + i}`);
    expect(checkSegmentation([item("x", "X", lines(25)), item("y1", "Y", lines(6)), item("y2", "Y", lines(6, 7)), item("y3", "Y", lines(9, 13))]).keys).toEqual(new Set(["x"]));
    expect(checkSegmentation(ITEMS).problems).toEqual([]);
  });

  it("locates a phrase exactly once across wrapped lines and pages, or says why not", () => {
    const lines = [{ page: 3, line: 24, text: "A.  Yes. The alarm was beeping the", role: "witness" }, { page: 4, line: 1, text: "whole   time.", role: "witness" }, { page: 4, line: 2, text: "Q.  The alarm?", role: "attorney" }];
    expect(locatePhrase("the alarm was beeping the whole time", lines)).toEqual({ from: "3:24", to: "4:1", roles: ["witness"] });
    expect(locatePhrase("The alarm", lines)).toEqual({ error: "found 2 times" });
    expect(locatePhrase("no such words", lines)).toEqual({ error: "not found" });
  });

  const labels = (pairs: CrossLabelFile["comparisons"][number]["pairs"], documents: CrossLabelFile["documents"] = {}): CrossLabelFile => ({ version: 1, set: "s", synthetic: true, about: "", documents, comparisons: [{ id: "c", witnessA: "A", witnessB: "B", pairs }], exclusions: [{ id: "X", reason: "dropped" }] });

  it("resolves held-out line labels to items, listing what it skips and lines no item holds", () => {
    const pairs = [
      { id: "H1", topic: "t", expected: "no_conflict" as const, a: { document: "a", lines: [2, 9] }, b: { document: "b", lines: [3] }, note: "n" },
      { id: "T", topic: "t", expected: "conflict_needs_context" as const, a: { document: "a", lines: [1] }, b: { document: "b", lines: [1] }, note: "n" },
      { id: "H2", topic: "t", expected: "conflict" as const, a: { document: "a", lines: [9] }, b: { document: "b", lines: [1] }, note: "n" },
      { id: "H3", topic: "t", expected: "conflict" as const, a: { document: "z", lines: [1] }, b: { document: "b", lines: [1] }, note: "n" },
    ];
    const r = heldOutPairs(labels(pairs), ITEMS, new Set(["T"]), "src");
    expect(r.pairs).toEqual([{ id: "H1", category: "no_conflict", expected: "no_conflict", topic: "t", source: "src", left: ["a1"], right: ["b2"], unmatchedLines: ["a 0:9"] }]);
    expect(r.skipped.map((s) => s.id)).toEqual(["X", "T", "H2", "H3"]);
  });

  it("builds a corpus fixture from phrase labels, every document its own session, unresolved phrases listed", () => {
    const doc = (w: string) => ({ file: `t/${w}.txt`, sha256: "0".repeat(64), witness: w, takenOn: "2025-01-01", session: "s" });
    const lines = new Map([["a", [{ page: 1, line: 5, text: "A. The light was red.", role: "witness" }]], ["b", [{ page: 2, line: 7, text: "A. It was green,", role: "witness" }, { page: 2, line: 8, text: "plainly.", role: "witness" }]]]);
    const pairs = [
      { id: "S1", topic: "t", expected: "conflict" as const, a: { document: "a", phrase: "light was red" }, b: { document: "b", phrase: "green, plainly" }, note: "n" },
      { id: "S2", topic: "t", expected: "no_conflict" as const, a: { document: "a", phrase: "light was blue" }, b: { document: "b", phrase: "green" }, note: "n" },
    ];
    const f = fixtureFromCrossLabels(labels(pairs, { a: doc("A"), b: doc("B") }), "root", lines, new Map([["a", "page_line"]]), "labels.json");
    expect(f.documents.a).toMatchObject({ local: "root/t/A.txt", loader: "text", session: "a", scheme: "page_line" });
    expect(f.documents.b.scheme).toBe("unrecognized");
    expect(f.items).toEqual([{ id: "S1", category: "conflict", label: "s#S1", sides: [{ document: "a", from: "1:5", to: "1:5", search: "light was red" }, { document: "b", from: "2:7", to: "2:8", search: "green, plainly" }] }]);
    expect(f.unresolved).toEqual([{ id: "S2", reason: "side a (a): phrase not found" }]);
  });
});
