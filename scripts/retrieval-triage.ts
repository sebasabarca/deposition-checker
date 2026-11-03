// Applies candidate triage (server/src/retrieve/triage.ts) to a frozen pool and writes the kept pairs as a
// CandidatePool and every deferral with its stage and reason. Prints stage counts, then, separately, where
// each labelled pair of benchmark.json ended (triage itself never sees the labels). No model or API call.
//
//   npx tsx scripts/retrieval-triage.ts --variant <name> [--frozen data/raw/retrieval/frozen-v1] [--pool pool-baseline-top5.json]
//     [--out data/raw/retrieval/agent-b] [--max-pairs 2500] [--per-item 1] [--rare-share 0.01] [--passage-gap 2]
//     [--min-content-words 2] [--near-duplicate 0.8]
//
// Outputs quote item keys only, but sit beside testimony: --out must be under the git-ignored data/raw/.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { readJson, writeJson, type CandidatePool, type FrozenBenchmark, type FrozenItem } from "../server/src/retrieve/frozen";
import { triage, type TriageOptions } from "../server/src/retrieve/triage";

const { values } = parseArgs({
  options: {
    variant: { type: "string" }, frozen: { type: "string" }, pool: { type: "string" }, out: { type: "string" },
    "max-pairs": { type: "string" }, "per-item": { type: "string" }, "rare-share": { type: "string" }, "passage-gap": { type: "string" },
    "min-content-words": { type: "string" }, "near-duplicate": { type: "string" },
  },
});

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

function main() {
  if (!values.variant || !/^[\w.-]+$/.test(values.variant)) throw new Error("needs --variant <name> (letters, digits, . _ -)");
  const frozen = values.frozen ?? "data/raw/retrieval/frozen-v1";
  const out = values.out ?? "data/raw/retrieval/agent-b";
  if (!path.resolve(out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out must be under data/raw/");
  const pool = readJson<CandidatePool>(path.join(frozen, values.pool ?? "pool-baseline-top5.json"));
  const items = readJson<FrozenItem[]>(path.join(frozen, "items.json"));
  const options: Partial<TriageOptions> = Object.fromEntries(Object.entries({
    maxPairs: num(values["max-pairs"]), perItem: num(values["per-item"]), rareShare: num(values["rare-share"]),
    passageGap: num(values["passage-gap"]), minContentWords: num(values["min-content-words"]), nearDuplicate: num(values["near-duplicate"]),
  }).filter(([, v]) => v !== undefined));
  for (const [k, v] of Object.entries(options)) if (!Number.isFinite(v)) throw new Error(`--${k} must be a number`);

  const result = triage(pool, items, options);
  if (result.kept.length + result.deferred.length !== pool.candidates.length) throw new Error("triage lost candidates");
  mkdirSync(out, { recursive: true });
  const kept: CandidatePool = { name: `${pool.name}-triaged-${values.variant}`, perItem: pool.perItem, paths: pool.paths, candidates: result.kept };
  writeJson(path.join(out, `pool-triaged-${values.variant}.json`), kept);
  writeJson(path.join(out, `deferred-${values.variant}.json`), { pool: pool.name, options, stages: result.stages, deferred: result.deferred.map((d) => ({ a: d.candidate.a, b: d.candidate.b, fused: d.candidate.fused, stage: d.stage, reason: d.reason })) });

  console.log(`${pool.name} → ${values.variant}: ${pool.candidates.length} in, ${result.kept.length} kept`);
  for (const s of result.stages) console.log(`  ${s.name.padEnd(15)} ${String(s.in).padStart(6)} → ${String(s.out).padStart(6)}`);

  // Evaluation, kept apart from triage: where did each labelled pair end?
  const bench = readJson<FrozenBenchmark>(path.join(frozen, "benchmark.json"));
  const joins = (l: Set<string>, r: Set<string>) => (c: { a: string; b: string }) => (l.has(c.a) && r.has(c.b)) || (l.has(c.b) && r.has(c.a));
  console.log("labelled pairs (evaluation only):");
  for (const p of bench.pairs) {
    const hit = joins(new Set(p.left), new Set(p.right));
    const fate = !pool.candidates.some(hit) ? "not in input pool"
      : result.kept.some(hit) ? "kept"
      : result.deferred.filter((d) => hit(d.candidate)).map((d) => `deferred at ${d.stage} (${d.reason})`).join("; ");
    console.log(`  ${p.id.padEnd(8)} ${p.category.padEnd(13)} ${fate}`);
  }
}

main();
