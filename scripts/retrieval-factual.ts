// The numeric, temporal and polarity retrieval path F_factual (server/src/retrieve/factual.ts) over a frozen
// corpus (server/src/retrieve/frozen.ts). No database, model or API call.
//
//   npx tsx scripts/retrieval-factual.ts --frozen <dir> --out <dir under data/raw> [--benchmark <file>...] [--depth 300] [--show <item key>...]
//     writes neighbours-F_factual.json (PathNeighbours, every item, other sessions only) and rankings-F_factual.json
//     (PathRankings: the full ranking from every item of benchmark.json's and each --benchmark file's sides),
//     and timings-F_factual.json. --union <pool file> --reserve <k> also writes that pool plus F_factual's own top k
//     per item (pool-<name>-reserve-F<k>.json), outside the rank fusion; --show prints an item's extracted values and claims (they quote testimony).

import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { factualNeighbours, indexItems } from "../server/src/retrieve/factual";
import { buildPool, pairKey, readJson, writeJson, type Candidate, type CandidatePool, type FrozenBenchmark, type FrozenItem, type PathNeighbours, type PathRankings, type Ranked } from "../server/src/retrieve/frozen";

const PATH = "F_factual";
const { values } = parseArgs({ options: { frozen: { type: "string" }, out: { type: "string" }, benchmark: { type: "string", multiple: true }, depth: { type: "string" }, show: { type: "string", multiple: true }, union: { type: "string" }, reserve: { type: "string" } } });
if (!values.frozen || !values.out) throw new Error("needs --frozen and --out");
if (!path.resolve(values.out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out derives from testimony: it must be under data/raw/");
const depth = Number(values.depth ?? 300);

const t0 = performance.now();
const items = readJson<FrozenItem[]>(path.join(values.frozen, "items.json"));
const index = new Map(items.map((i, k) => [i.key, k]));
const benchmarks = [path.join(values.frozen, "benchmark.json"), ...(values.benchmark ?? [])].map((f) => readJson<FrozenBenchmark>(f));
const sides = new Set(benchmarks.flatMap((b) => b.pairs.flatMap((p) => [...p.left, ...p.right])).map((k) => index.get(k)).filter((k): k is number => k !== undefined));

const ix = indexItems(items);
const tIndex = performance.now();
for (const key of values.show ?? []) console.log(key, JSON.stringify(ix.facts[index.get(key)!], null, 1));
const lists = factualNeighbours(items, depth, sides, ix);
const tRank = performance.now();

const ranked = (k: number, n = Infinity): Ranked[] => lists[k].slice(0, n).map((x) => [items[x.id].key, x.score]);
mkdirSync(values.out, { recursive: true });
writeJson(path.join(values.out, `neighbours-${PATH}.json`), { path: PATH, depth, neighbours: Object.fromEntries(items.map((i, k) => [i.key, ranked(k, depth)])) } satisfies PathNeighbours);
writeJson(path.join(values.out, `rankings-${PATH}.json`), { path: PATH, rankings: Object.fromEntries([...sides].map((k) => [items[k].key, ranked(k)])) } satisfies PathRankings);
const withFacts = ix.facts.filter((f) => f.values.length || f.claims.length).length;
const timings = {
  items: items.length, itemsWithValues: ix.facts.filter((f) => f.values.length).length, itemsWithClaims: ix.facts.filter((f) => f.claims.length).length, itemsWithFacts: withFacts,
  values: ix.facts.reduce((s, f) => s + f.values.length, 0), claims: ix.facts.reduce((s, f) => s + f.claims.length, 0),
  itemsWithNeighbours: lists.filter((l) => l.length).length, meanNeighbours: Math.round((lists.reduce((s, l) => s + Math.min(l.length, depth), 0) / items.length) * 10) / 10,
  indexMs: Math.round(tIndex - t0), rankMs: Math.round(tRank - tIndex), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
};
writeJson(path.join(values.out, `timings-${PATH}.json`), timings);
console.log(JSON.stringify(timings));

// A sole path's first rank cannot reach a fused top 5 against paths that agree with each other, so the
// reserved pool takes F_factual's own top k per item beside the fused pool, with F's ranks attached.
if (values.union) {
  const base = readJson<CandidatePool>(values.union);
  const k = Number(values.reserve ?? 1);
  const own = buildPool(PATH, [{ path: PATH, depth, neighbours: Object.fromEntries(items.map((i, n) => [i.key, ranked(n, depth)])) }], k);
  const fRank = new Map(own.candidates.map((c) => [pairKey(c.a, c.b), c.ranks[PATH]]));
  const rankOf = new Map(items.map((i, n) => [i.key, new Map(lists[n].map((x, r) => [items[x.id].key, r + 1]))]));
  const ranks = (a: string, b: string): [number | null, number | null] => fRank.get(pairKey(a, b)) ?? [rankOf.get(a)?.get(b) ?? null, rankOf.get(b)?.get(a) ?? null];
  const have = new Set(base.candidates.map((c) => pairKey(c.a, c.b)));
  const none = Object.fromEntries(base.paths.map((p) => [p, [null, null]])) as Candidate["ranks"];
  const added = own.candidates.filter((c) => !have.has(pairKey(c.a, c.b))).map((c) => ({ ...c, fused: 0, ranks: { ...none, [PATH]: c.ranks[PATH] } }));
  const name = `${base.name}-reserve-F${k}`;
  writeJson(path.join(values.out, `pool-${name}.json`), { name, perItem: base.perItem, paths: [...base.paths, PATH], candidates: [...base.candidates.map((c) => ({ ...c, ranks: { ...c.ranks, [PATH]: ranks(c.a, c.b) } })), ...added] } satisfies CandidatePool);
  console.log(`${name}: ${base.candidates.length} + ${added.length} reserved = ${base.candidates.length + added.length} candidates`);
}
