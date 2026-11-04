// Local reranking's pure parts on hand-built inputs: text, windows, scores, orders that never drop a candidate.
// The model tests run only when the pinned models are already in data/raw/models/; they never download.
import { describe, expect, it } from "vitest";
import type { CandidatePool } from "../../server/src/retrieve/frozen";
import { agreementOrder, fuseOrders, orderByScore, pairScore, pairWindows, perItemOrder, relatedContradiction, rerankText, sameCandidates, softmax } from "../../server/src/retrieve/rerank";
import { loadReranker, rerankFilesPresent } from "../../server/src/retrieve/rerankModels";

const pool: CandidatePool = {
  name: "p", perItem: 5, paths: ["A", "B"],
  candidates: [
    { a: "a", b: "x", fused: 0.04, ranks: { A: [1, 9], B: [null, null] } },
    { a: "b", b: "y", fused: 0.03, ranks: { A: [2, 1], B: [1, 3] } },
    { a: "c", b: "z", fused: 0.02, ranks: { A: [8, null], B: [9, 9] } },
  ],
};
const order = (p: CandidatePool) => p.candidates.map((c) => c.a);

describe("text", () => {
  it("keeps question and answer without speaker labels, after the last context words", () => {
    expect(rerankText({ question: "Q: Did it rain?", answer: "A: No.", context: "one two three Q: And then? A: We left." }, 3)).toBe("then? We left. Did it rain? No.");
    expect(rerankText({ question: "Q: Did it rain?", answer: "A: No.", context: "" })).toBe("Did it rain? No.");
  });
});

describe("pair windows", () => {
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i);
  it("keeps both sides whole when they fit", () => expect(pairWindows(seq(5), seq(4), 12)).toEqual([[seq(5), seq(4)]]));
  it("windows a long side beside a short one, covering every token, never over the limit", () => {
    const ws = pairWindows(seq(20), seq(3), 13, 2);
    expect(ws.every(([a, b]) => a.length + b.length + 3 <= 13 && b.length === 3)).toBe(true);
    expect(new Set(ws.flatMap(([a]) => a))).toEqual(new Set(seq(20)));
  });
  it("windows two long sides, every window of one with every window of the other", () => {
    const ws = pairWindows(seq(20), seq(20), 23, 2);
    expect(ws.every(([a, b]) => a.length + b.length + 3 <= 23)).toBe(true);
    expect(new Set(ws.flatMap(([, b]) => b))).toEqual(new Set(seq(20)));
    expect(ws.length).toBe(3 * 3);
  });
});

describe("scores", () => {
  it("softmax sums to one and keeps order", () => {
    const p = softmax([2, 0, -1]);
    expect(p.reduce((x, y) => x + y)).toBeCloseTo(1);
    expect(p[0]).toBeGreaterThan(p[1]);
  });
  it("takes the strongest window in either direction", () => expect(pairScore([0.1, 0.7], [0.3])).toBe(0.7));
  it("scales contradiction by relatedness", () => {
    expect(relatedContradiction(0.9, 0)).toBeCloseTo(0.45);
    expect(relatedContradiction(0.9, 8)).toBeGreaterThan(relatedContradiction(0.9, -8));
  });
});

describe("orders never drop a candidate", () => {
  it("orders by score, unscored last, ties in pool order", () => {
    const o = orderByScore(pool, new Map([["c|z", 5], ["b|y", 5]]), "s");
    expect(order(o)).toEqual(["b", "c", "a"]);
    expect(sameCandidates(pool, o)).toBe(true);
  });
  it("fuses the pool's order with a model's", () => {
    const model = orderByScore(pool, new Map([["c|z", 9], ["a|x", 1], ["b|y", 0]]), "m");
    const f = fuseOrders(pool, [model], "f");
    expect(order(f)).toEqual(["a", "c", "b"]); // a: 1/61+1/62, c: 1/63+1/61, b: 1/62+1/63
    expect(sameCandidates(pool, f)).toBe(true);
  });
  it("orders by cross-path agreement, then pool order", () => {
    expect(order(agreementOrder(pool, "g"))).toEqual(["b", "a", "c"]);
  });
  it("puts each item's best partner first, so one passage that scores high everywhere takes one slot per rank", () => {
    const c = (a: string, b: string) => ({ a, b, fused: 0, ranks: {} });
    const p: CandidatePool = { ...pool, candidates: [c("m", "x"), c("m", "n"), c("n", "x"), c("q", "r")] };
    // m-x is second for both m (after m-n) and x (after n-x), so it follows q-r despite its higher score.
    const o = perItemOrder(p, new Map([["m|n", 0.99], ["n|x", 0.98], ["m|x", 0.97], ["q|r", 0.5]]), "i");
    expect(o.candidates.map((x) => x.a + x.b)).toEqual(["mn", "nx", "qr", "mx"]);
    expect(sameCandidates(p, o)).toBe(true);
  });
  it("notices a lost candidate", () => expect(sameCandidates(pool, { ...pool, candidates: pool.candidates.slice(1) })).toBe(false));
});

describe.skipIf(!rerankFilesPresent("ce") || !rerankFilesPresent("nli"))("local models (on disk only)", () => {
  it("scores a conflicting answer as a contradiction, offline", async () => {
    const nli = await loadReranker("nli");
    const [conflict, same] = await nli.score([["Did the alarm sound? Yes, it beeped.", "Did the alarm sound? No, it was silent."], ["Did the alarm sound? Yes, it beeped.", "Did the alarm sound? Yes, it beeped twice."]]);
    expect(conflict.score).toBeGreaterThan(0.5);
    expect(conflict.score).toBeGreaterThan(same.score);
    const ce = await loadReranker("ce");
    const [related, unrelated] = await ce.score([["Did the alarm sound?", "The backup alarm beeped as it reversed."], ["Did the alarm sound?", "The invoice was paid in March."]]);
    expect(related.score).toBeGreaterThan(unrelated.score);
    const long = await ce.score([["word ".repeat(900), "alarm ".repeat(900)]]);
    expect(long[0].windows).toBeGreaterThan(1);
    expect(nli.fetchAttempts() + ce.fetchAttempts()).toBe(0);
  }, 60000);
});
