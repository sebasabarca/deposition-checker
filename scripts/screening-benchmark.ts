// Milestone 3 offline screening benchmark: screens the frozen within-case packet sets of both corpora with
// every strategy, checks that every pool pair is accounted for, and reports what each budget prioritizes and
// defers. Corpus 1 is real testimony, corpus 2 synthetic; they are reported apart. Labels are read only to
// measure. No model, API or database call.
//
//   npx tsx scripts/screening-benchmark.ts [--raw data/raw] [--out data/raw/screening/baseline]
//
// --raw is the data/raw folder holding the frozen corpora and the Milestone 1 packet sets. Every input's
// SHA-256 is recorded before and after the run. Output (git-ignored, it names testimony items): report.json.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { caseOfDocument, withinCase } from "../server/src/eval/retrievalEval";
import { evaluateScreening, COST_ASSUMPTIONS } from "../server/src/eval/screeningBenchmark";
import { readJson, sha256File, writeJson, type CandidatePool, type FrozenBenchmark, type FrozenItem } from "../server/src/retrieve/frozen";
import type { PacketSet } from "../server/src/retrieve/grouping";
import { accountFor } from "../server/src/screen/contract";
import { screen, STRATEGIES } from "../server/src/screen/strategies";

const { values } = parseArgs({ options: { raw: { type: "string" }, out: { type: "string" } } });
const raw = values.raw ?? "data/raw";
const out = values.out ?? "data/raw/screening/baseline";
if (!path.resolve(out).includes(`${path.sep}data${path.sep}raw${path.sep}`)) throw new Error("--out must be under a data/raw/ folder");
const R = path.join(raw, "retrieval/round2");

const CORPORA = [
  { id: "c1", kind: "real", frozen: `${R}/agent-6/frozen-v2`, labels: [`${R}/agent-6/frozen-v2/benchmark.json`, `${R}/agent-6/heldout-c1v2.json`],
    pool: `${R}/lead/ladder/c1/pool-triaged-c1v2-combined.json`, packets: path.join(raw, "retrieval/m1-baseline/eval-c1/packets-pool-triaged-c1v2-combined-within-case.json"),
    casePattern: "^hutchinson|^(?=simpson|resnick)" },
  { id: "c2", kind: "synthetic", frozen: `${R}/agent-6/frozen-corpus2-v2`, labels: [`${R}/agent-6/frozen-corpus2-v2/benchmark.json`],
    pool: `${R}/lead/ladder/c2/pool-triaged-c2v2-combined.json`, packets: path.join(raw, "retrieval/m1-baseline/eval-c2/packets-pool-triaged-c2v2-combined-within-case.json"),
    casePattern: "^([AB][0-9][0-9])_" },
];
// Budgets as shares of the open packets, so both corpora are read alike; corpus 1's 300 and 500 are added.
const SHARES = [0.03, 0.09, 0.15, 0.3, 0.5, 1];

const report: Record<string, unknown>[] = [];
const hashes = (c: (typeof CORPORA)[number]) => Object.fromEntries([path.join(c.frozen, "items.json"), ...c.labels, c.pool, c.packets].map((f) => [f, sha256File(f)]));
mkdirSync(out, { recursive: true });
for (const c of CORPORA) {
  const before = hashes(c);
  const items = readJson<FrozenItem[]>(path.join(c.frozen, "items.json"));
  const byKey = new Map(items.map((i) => [i.key, i]));
  const labels = c.labels.flatMap((f) => readJson<FrozenBenchmark>(f).pairs);
  const pool = withinCase(readJson<CandidatePool>(c.pool), byKey, caseOfDocument(new RegExp(c.casePattern)));
  const set = readJson<PacketSet>(c.packets);
  console.log(`\n${c.id} (${c.kind}): ${items.length} items, ${pool.candidates.length} within-case pool pairs, ${set.packets.length} packets, ${set.uncovered.length} uncovered, ${labels.length} labelled pairs`);
  for (const strategy of STRATEGIES) for (const consolidate of [false, true]) {
    if (consolidate && strategy !== "deterministic" && strategy !== "coverage") continue;
    const t0 = performance.now();
    const results = screen(set, pool, items, { strategy, budget: 0, consolidate });
    const ms = Math.round(performance.now() - t0);
    const acc = accountFor(pool, set, results);
    const open = acc.prioritized + acc.deferred;
    const budgets = [...new Set([...SHARES.map((s) => Math.max(1, Math.round(s * open))), ...(c.id === "c1" ? [300, 500] : [])])].sort((a, b) => a - b);
    const ev = evaluateScreening(results, labels, byKey, budgets);
    const name = `${strategy}${consolidate ? "+consolidate" : ""}`;
    console.log(`  ${name.padEnd(26)} ${ms} ms, open ${open}, consolidated ${acc.consolidated}, accounting problems ${acc.problems.length}, reference problems ${ev.problems.length}`);
    console.log(`    targets first rank: ${ev.labels.filter((l) => l.kind === "target").map((l) => `${l.id}@${l.firstRank ?? "-"}`).join(" ")}`);
    for (const b of ev.budgets) console.log(`    k=${String(b.budget).padStart(5)}  targets ${b.targets.reached}/${b.targets.of}  controls ${b.controls.reached}/${b.controls.of}  pairs ${b.listedPairs}  reads ${b.itemReads}/${b.distinctItems} distinct  $${b.expectedUsd} (no cache $${b.noCacheUsd})  sessions with none: ${b.sessionsWithNone.join(", ") || "-"}`);
    report.push({ corpus: c.id, kind: c.kind, run: name, ms, accounting: acc, ...ev });
  }
  const after = hashes(c);
  for (const f of Object.keys(before)) if (before[f] !== after[f]) throw new Error(`${f} changed during the run`);
  report.push({ corpus: c.id, inputs: before });
}
const mem = process.resourceUsage().maxRSS / 1024;
console.log(`\npeak memory ${(mem / 1024).toFixed(2)} GB; cost assumptions: ${COST_ASSUMPTIONS.source}`);
writeJson(path.join(out, "report.json"), { costAssumptions: COST_ASSUMPTIONS, peakRssMb: Math.round(mem), runs: report });
console.log(`wrote ${out}/report.json`);
