// The faster neighbour searches (bounded top-k, each dense pair once, inverted indexes for the factual path) against
// the plain all-pairs reference they replaced, on SYNTHETIC inputs with many tied scores: the lists must be identical.
import { describe, expect, it } from "vitest";
import { denseNeighboursParallel } from "../../server/src/retrieve/denseParallel";
import { factualNeighbours, indexItems, pairScore, type FactualItem } from "../../server/src/retrieve/factual";
import { anchorNeighbours, denseNeighbours, sparseNeighbours, TopK, type Item, type Neighbour, type SparseVector } from "../../server/src/retrieve/independent";

let seed = 11;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const items: Item[] = Array.from({ length: 300 }, (_, id) => ({ id, session: Math.floor(random() * 5), question: "", answer: "", context: "" }));
const eligible = (i: number) => i % 7 !== 3;

// The replaced implementation: score every partner into a Map, sort all, keep k.
const referenceTop = (acc: Map<number, number>, k: number): Neighbour[] => [...acc].filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, k).map(([id, score]) => ({ id, score }));

describe("exact faster neighbour search", () => {
  it("TopK keeps what a full sort keeps, ties broken by id", () => {
    const offers = Array.from({ length: 500 }, (_, id) => [id, Math.round(random() * 10) / 10 - 0.2] as const);
    for (const k of [0, 1, 7, 100, 1000]) {
      const top = new TopK(k);
      for (const [id, s] of [...offers].reverse()) top.offer(id, s);
      expect(top.sorted()).toEqual(referenceTop(new Map(offers), k));
    }
  });

  it("denseNeighbours (and on threads) equals the all-pairs reference, with eligibility and selected rows", async () => {
    // Coarse values so many scores tie exactly.
    const vectors = items.map(() => Float64Array.from({ length: 6 }, () => Math.round(random() * 4) / 4 - 0.25));
    const reference = (k: number, rows?: ReadonlySet<number>) => vectors.map((v, d) => {
      if (rows && !rows.has(d)) return [];
      const acc = new Map<number, number>();
      vectors.forEach((w, e) => { if (e === d || !eligible(e) || items[e].session === items[d].session) return; let s = 0; for (let j = 0; j < v.length; j++) s += v[j] * w[j]; acc.set(e, s); });
      return referenceTop(acc, k);
    });
    expect(denseNeighbours(items, vectors, 10, eligible)).toEqual(reference(10));
    for (const threads of [2, 7]) expect(await denseNeighboursParallel(items, vectors, 10, threads)).toEqual(denseNeighbours(items, vectors, 10));
    const rows = new Set([0, 5, 299]);
    expect(denseNeighbours(items, vectors, items.length, eligible, rows)).toEqual(reference(items.length, rows));
  });

  it("sparse and anchor neighbours equal the Map reference", () => {
    const vectors: SparseVector[] = items.map(() => new Map(Array.from({ length: 4 }, () => [Math.floor(random() * 40), Math.round(random() * 3) / 3] as [number, number])));
    const postings = new Map<number, [number, number][]>();
    vectors.forEach((v, d) => { if (eligible(d)) for (const [t, x] of v) (postings.get(t) ?? postings.set(t, []).get(t)!).push([d, x]); });
    const reference = vectors.map((v, d) => {
      const acc = new Map<number, number>();
      for (const [t, x] of v) for (const [e, y] of postings.get(t) ?? []) if (items[e].session !== items[d].session) acc.set(e, (acc.get(e) ?? 0) + x * y);
      return referenceTop(acc, 8);
    });
    expect(sparseNeighbours(items, vectors, 8, eligible)).toEqual(reference);
    const own = items.map(() => [`name:${Math.floor(random() * 30)}`, `year:${Math.floor(random() * 10)}`]);
    const ctx = items.map(() => [`name:${Math.floor(random() * 30)}`]);
    const weights = items.map((_, d) => { const w = new Map<string, number>(); for (const x of ctx[d]) w.set(x, 0.5); for (const x of own[d]) w.set(x, 1); return w; });
    const df = new Map<string, number>();
    for (const w of weights) for (const x of w.keys()) df.set(x, (df.get(x) ?? 0) + 1);
    const idf = (x: string) => Math.log(1 + items.length / (df.get(x) ?? 1));
    const ap = new Map<string, [number, number][]>();
    weights.forEach((w, d) => { for (const [x, y] of w) (ap.get(x) ?? ap.set(x, []).get(x)!).push([d, y]); });
    const anchorReference = weights.map((w, d) => {
      const acc = new Map<number, number>();
      for (const [x, y] of w) { if ((df.get(x) ?? 0) > Math.max(20, items.length * 0.05)) continue; for (const [e, z] of ap.get(x) ?? []) if (items[e].session !== items[d].session) acc.set(e, (acc.get(e) ?? 0) + y * z * idf(x)); }
      return referenceTop(acc, 8);
    });
    expect(anchorReference.some((l) => l.length > 0)).toBe(true);
    expect(anchorNeighbours(items, own, ctx, 8)).toEqual(anchorReference);
  });

  it("factualNeighbours scores the same partners as a full scan", () => {
    const subjects = ["freezer gauge", "bakery truck", "overnight shift", "loading dock", "cash register", "payroll records"];
    const fitems: FactualItem[] = Array.from({ length: 120 }, (_, i) => {
      const s = subjects[i % subjects.length];
      const n = 5 + Math.floor(random() * 4) * 5;
      const neg = random() < 0.4 ? " not" : "";
      return { session: `s${Math.floor(random() * 3)}`, witness: "Ann Lee", question: `Q. What about the ${s}?`, answer: `A. The ${s} read ${n} degrees. I was${neg} at the ${s} that night.`, context: "" };
    });
    const ix = indexItems(fitems);
    const reference = fitems.map((it, a) => {
      if (!ix.facts[a].values.length && !ix.facts[a].claims.length) return [];
      const out: Neighbour[] = [];
      for (let b = 0; b < fitems.length; b++) {
        if ((!ix.facts[b].values.length && !ix.facts[b].claims.length) || fitems[b].session === it.session) continue;
        const s = pairScore(ix, a, b);
        if (s > 0) out.push({ id: b, score: Math.round(s * 1e6) / 1e6 });
      }
      return out.sort((x, y) => y.score - x.score || x.id - y.id);
    });
    expect(reference.some((l) => l.length > 0)).toBe(true);
    expect(factualNeighbours(fitems, 1000, new Set(), ix)).toEqual(reference);
    expect(factualNeighbours(fitems, 3, new Set([0]), ix)).toEqual(reference.map((l, a) => (a === 0 ? l : l.slice(0, 3))));
  });
});
