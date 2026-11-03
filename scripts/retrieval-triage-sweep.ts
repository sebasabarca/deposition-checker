// Triage sweep over both frozen corpora (lead integration experiment): candidate counts and labelled-pair
// survival for each triage variant on the five-path pools. Reads pools built by scripts/retrieval-pools.ts
// under data/raw/retrieval/lead/pools/. No model or API call.
//   npx tsx scripts/retrieval-triage-sweep.ts
import { poolHolds, readJson, type CandidatePool, type FrozenBenchmark, type FrozenItem } from "../server/src/retrieve/frozen";
import { triage } from "../server/src/retrieve/triage";
const corpora = [
  { name: "corpus1", frozen: "data/raw/retrieval/frozen-v1", pool: "data/raw/retrieval/lead/pools/pool-c1-add-minilm.json", extra: ["data/eval/simpson-resnick-heldout-v1.json"] },
  { name: "corpus2", frozen: "data/raw/retrieval/agent-c/frozen-corpus2-v1", pool: "data/raw/retrieval/lead/pools/pool-c2-add-minilm.json", extra: [] },
];
const BAD = ["A03_witness1", "A05_witness2", "B03_witness1", "B05_witness2"];
const variants: [string, Record<string, unknown>][] = [["B original (rare 1%, 1 per item)", { rareShare: 0.01, perItem: 1 }], ["no rare gate, 1 per item", { rareShare: null, perItem: 1 }], ["no rare gate, 2 per item (default)", { rareShare: null, perItem: 2 }]];
for (const c of corpora) {
  const items = readJson<FrozenItem[]>(`${c.frozen}/items.json`);
  const pairs = [readJson<FrozenBenchmark>(`${c.frozen}/benchmark.json`), ...c.extra.map((f) => readJson<FrozenBenchmark>(f))].flatMap((b) => b.pairs);
  const pool = readJson<CandidatePool>(c.pool);
  const budget = Math.round(items.length * 2500 / 5620);
  const isT = (p: FrozenBenchmark["pairs"][number]) => !["control", "no_conflict", "exploratory"].includes(p.category);
  const aff = (p: FrozenBenchmark["pairs"][number]) => [...p.left, ...p.right].some((k) => BAD.some((d) => k.startsWith(`${d}#`)));
  const count = (pl: CandidatePool) => { const held = (p: FrozenBenchmark["pairs"][number]) => poolHolds(pl, new Set(p.left), new Set(p.right)); const t = pairs.filter(isT); return `targets clean ${t.filter((p) => !aff(p) && held(p)).length}/${t.filter((p) => !aff(p)).length}${t.some(aff) ? `, artifact-affected ${t.filter((p) => aff(p) && held(p)).length}/${t.filter(aff).length}` : ""}, controls ${pairs.filter((p) => !isT(p) && held(p)).length}/${pairs.filter((p) => !isT(p)).length} | missed clean: ${t.filter((p) => !aff(p) && !held(p)).map((p) => p.id).join(",")}`; };
  console.log(`\n${c.name}: ${items.length} items, input pool ${pool.candidates.length}: ${count(pool)}; budget ${budget}`);
  for (const [label, opts] of variants) for (const b of [null, budget, Math.round(budget / 2.5)]) {
    const r = triage(pool, items, { ...opts, maxPairs: b } as never);
    console.log(`  ${label.padEnd(22)} budget ${String(b ?? "none").padEnd(5)} kept ${String(r.kept.length).padStart(5)} | ${count({ ...pool, candidates: r.kept })}`);
  }
}
// Iteration 3: order the coverage survivors by cross-path agreement, then fused score, instead of the ratio test.
console.log("\niteration 3: agreement ordering after the no-gate coverage stage");
for (const c of corpora) {
  const items = readJson<FrozenItem[]>(`${c.frozen}/items.json`);
  const pairs = [readJson<FrozenBenchmark>(`${c.frozen}/benchmark.json`), ...c.extra.map((f) => readJson<FrozenBenchmark>(f))].flatMap((b) => b.pairs);
  const pool = readJson<CandidatePool>(c.pool);
  const isT = (p: FrozenBenchmark["pairs"][number]) => !["control", "no_conflict", "exploratory"].includes(p.category);
  const aff = (p: FrozenBenchmark["pairs"][number]) => [...p.left, ...p.right].some((k) => BAD.some((d) => k.startsWith(`${d}#`)));
  for (const perItem of [1, 2]) {
    const kept = triage(pool, items, { rareShare: null, perItem }).kept;
    const agree = (x: (typeof kept)[number], k: number) => Object.values(x.ranks).filter(([ab, ba]) => Math.min(ab ?? Infinity, ba ?? Infinity) <= k).length;
    for (const k of [3, 10]) {
      const sorted = [...kept].sort((x, y) => agree(y, k) - agree(x, k) || y.fused - x.fused);
      const pos = (p: FrozenBenchmark["pairs"][number]) => { const L = new Set(p.left), R = new Set(p.right); const i = sorted.findIndex((x) => (L.has(x.a) && R.has(x.b)) || (L.has(x.b) && R.has(x.a))); return i < 0 ? "-" : String(i + 1); };
      console.log(`  ${c.name} perItem ${perItem}, agreement top-${k}: of ${sorted.length} | clean targets at ${pairs.filter((p) => isT(p) && !aff(p)).map((p) => `${p.id}@${pos(p)}`).join(" ")}`);
    }
  }
}
