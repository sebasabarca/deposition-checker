// Groups candidate pools into bounded evidence packets (server/src/retrieve/grouping.ts) and measures the
// projected workload against pair-by-pair adjudication, over a sweep of size bounds. Evaluation, kept apart
// from grouping: labelled pairs whose two sides share a packet, packets mixing two different cases or
// scenarios (a sure sign of an unrelated merge), items left out and pairs uncovered. No model or API call.
//
//   npx tsx scripts/retrieval-group.ts [--out data/raw/retrieval/round2/agent-5] [--pools data/raw/retrieval/lead/pools]
//
// Writes, under --out (git-ignored data/raw, since samples quote testimony): sweep.json, one PacketSet per
// pool at the chosen settings (packets-<pool>.json) and samples-<pool>.txt with packets' text for inspection.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { kindOf } from "../server/src/eval/retrievalEval";
import { readJson, writeJson, type CandidatePool, type FrozenBenchmark, type FrozenItem } from "../server/src/retrieve/frozen";
import { coPacketed, DEFAULT_GROUPING, groupPool, pairwiseWorkload, workload, type GroupingSettings, type PacketSet } from "../server/src/retrieve/grouping";

const { values } = parseArgs({ options: { out: { type: "string" }, pools: { type: "string" } } });
const out = values.out ?? "data/raw/retrieval/round2/agent-5";
const pools = values.pools ?? "data/raw/retrieval/lead/pools";
if (!path.resolve(out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out must be under data/raw/");

const CORPORA = [
  { id: "c1", frozen: "data/raw/retrieval/frozen-v1", labels: ["benchmark.json", "data/eval/simpson-resnick-heldout-v1.json"], pools: ["pool-triaged-c1-default.json", "pool-c1-add-minilm.json"],
    caseOf: (doc: string) => (doc.startsWith("hutchinson") ? "hutchinson" : "simpson-resnick") },
  { id: "c2", frozen: "data/raw/retrieval/agent-c/frozen-corpus2-v1", labels: ["benchmark.json"], pools: ["pool-triaged-c2-default.json", "pool-c2-add-minilm.json"],
    caseOf: (doc: string) => doc.split("_")[0] }, // A01 … B05: each scenario is its own set of events
];
// Corpus-2 documents Agent 1 is re-parsing: results touching them are provisional.
const PROVISIONAL = new Set(["A03_witness1", "A05_witness2", "B03_witness1", "B05_witness2"]);

// Iterations (cause → change → effect in the report) and the size curve.
const VARIANTS: Record<string, Partial<GroupingSettings>> = {
  "i0-pool-graph": { minShared: 0, coreShare: 0, starOneSession: false }, // any pool pair joins clusters
  "i1-shared-features": { minShared: 2, coreShare: 0, starOneSession: false }, // two shared rare features required
  "i2-core-feature": { minShared: 2, coreShare: 0.5, starOneSession: false }, // and one feature most of the packet shares, from both sides
  "i3-star-one-session": { minShared: 2, coreShare: 0.5, starOneSession: true }, // and residual stars keep to one other session
};
const MAX_ITEMS = [4, 6, 8, 12, 16];
const MAX_TOKENS = [4000, 6000, 10000];
const CHOSEN = { variant: "i3-star-one-session", maxItems: DEFAULT_GROUPING.maxItems, maxTokens: DEFAULT_GROUPING.maxTokens };

const sweep: Record<string, unknown>[] = [];
mkdirSync(out, { recursive: true });
for (const corpus of CORPORA) {
  const items = readJson<FrozenItem[]>(path.join(corpus.frozen, "items.json"));
  const byKey = new Map(items.map((i) => [i.key, i]));
  const labelled = corpus.labels.flatMap((f) => readJson<FrozenBenchmark>(f.includes("/") ? f : path.join(corpus.frozen, f)).pairs);
  for (const poolFile of corpus.pools) {
    const pool = readJson<CandidatePool>(path.join(pools, poolFile));
    const pairwise = pairwiseWorkload(pool, items);
    const poolItems = new Set(pool.candidates.flatMap((c) => [c.a, c.b]));
    const poolPairs = new Set(pool.candidates.map((c) => `${c.a}|${c.b}`));
    const caseKey = (k: string) => corpus.caseOf(byKey.get(k)!.document);
    const crossCasePairs = pool.candidates.filter((c) => caseKey(c.a) !== caseKey(c.b)).length;
    // A packet that puts two different cases' passages side by side although the pool never paired them.
    const induced = (keys: string[]) => keys.some((u, i) => keys.slice(i + 1).some((v) => caseKey(u) !== caseKey(v) && !poolPairs.has(u < v ? `${u}|${v}` : `${v}|${u}`)));
    const held = (l: string[], r: string[]) => pool.candidates.some((c) => (l.includes(c.a) && r.includes(c.b)) || (l.includes(c.b) && r.includes(c.a)));
    console.log(`\n${poolFile}: ${pool.candidates.length} pairs over ${poolItems.size} items; pair by pair ${pairwise.calls} calls, ${(pairwise.tokens / 1e6).toFixed(2)}M tokens; ${crossCasePairs} pairs join two different cases`);
    console.log("variant              items tokens packets avgI maxI  avgTok maxTok   Mtok  calls% tok%  targets controls mixed/induced/polluted  uncov ungrouped");
    for (const [variant, settings] of Object.entries(VARIANTS)) for (const maxItems of MAX_ITEMS) for (const maxTokens of MAX_TOKENS) {
      const set = groupPool(pool, items, `${poolFile}:${variant}:${maxItems}:${maxTokens}`, poolFile, { ...settings, maxItems, maxTokens });
      const w = workload(set);
      if (w.pairsCovered + w.uncovered !== pool.candidates.length) throw new Error("grouping lost pairs");
      const scored = (kind: string) => { const ps = labelled.filter((p) => kindOf(p.category) === kind && held(p.left, p.right)); return { inPool: ps.length, coPacketed: ps.filter((p) => coPacketed(set, p.left, p.right)).length }; };
      const mixed = set.packets.filter((p) => new Set(p.items.map((k) => corpus.caseOf(byKey.get(k)!.document))).size > 1);
      const grouped = new Set(set.packets.flatMap((p) => p.items));
      const row = {
        corpus: corpus.id, pool: poolFile, variant, boundItems: maxItems, boundTokens: maxTokens, ...w,
        callShare: w.calls / pairwise.calls, tokenShare: w.tokens / pairwise.tokens,
        issuePackets: set.packets.filter((p) => p.id.startsWith("issue")).length,
        targets: scored("target"), controls: scored("control"),
        mixedPackets: mixed.length, mixedIssuePackets: mixed.filter((p) => p.id.startsWith("issue")).length,
        inducedMixPackets: mixed.filter((p) => induced(p.items)).length, // grouping's own unrelated merges
        inducedMixIssuePackets: mixed.filter((p) => p.id.startsWith("issue") && induced(p.items)).length,
        pollutedPackets: mixed.filter((p) => p.pairs.some(([a, b]) => caseKey(a) === caseKey(b))).length, // a same-case pair read beside another case
        crossCasePoolPairs: crossCasePairs,
        provisionalPackets: set.packets.filter((p) => p.items.some((k) => PROVISIONAL.has(byKey.get(k)!.document))).length,
        ungrouped: [...poolItems].filter((k) => !grouped.has(k)).length,
        uncoveredReasons: Object.fromEntries([...new Set(set.uncovered.map((u) => u.reason))].map((r) => [r, set.uncovered.filter((u) => u.reason === r).length])),
      };
      sweep.push(row);
      console.log(`${variant.padEnd(20)} ${String(maxItems).padStart(5)} ${String(maxTokens).padStart(6)} ${String(w.packets).padStart(7)} ${w.avgItems.toFixed(1).padStart(4)} ${String(w.maxItems).padStart(4)} ${w.avgTokens.toFixed(0).padStart(7)} ${String(w.maxTokens).padStart(6)} ${(w.tokens / 1e6).toFixed(2).padStart(6)} ${(100 * row.callShare).toFixed(0).padStart(6)} ${(100 * row.tokenShare).toFixed(0).padStart(4)} ${`${row.targets.coPacketed}/${row.targets.inPool}`.padStart(8)} ${`${row.controls.coPacketed}/${row.controls.inPool}`.padStart(8)} ${`${mixed.length}/${row.inducedMixPackets}/${row.pollutedPackets}`.padStart(22)} ${String(w.uncovered).padStart(6)} ${String(row.ungrouped).padStart(9)}`);
      if (variant === CHOSEN.variant && maxItems === CHOSEN.maxItems && maxTokens === CHOSEN.maxTokens) {
        writeJson(path.join(out, `packets-${poolFile.replace(/^pool-|\.json$/g, "")}.json`), set);
        writeFileSync(path.join(out, `samples-${poolFile.replace(/^pool-|\.json$/g, "")}.txt`), samples(set, byKey, corpus.caseOf));
      }
    }
  }
}
writeJson(path.join(out, "sweep.json"), sweep);
console.log(`\nwrote ${out}`);

// Every 40th issue packet and every 80th star packet, plus every packet mixing cases, with each passage's text.
function samples(set: PacketSet, byKey: Map<string, FrozenItem>, caseOf: (doc: string) => string): string {
  const mixed = (p: PacketSet["packets"][number]) => new Set(p.items.map((k) => caseOf(byKey.get(k)!.document))).size > 1;
  const issues = set.packets.filter((p) => p.id.startsWith("issue"));
  const stars = set.packets.filter((p) => p.id.startsWith("star"));
  const chosen = [...issues.filter((_, i) => i % 40 === 0), ...stars.filter((_, i) => i % 80 === 0), ...set.packets.filter(mixed)];
  return [...new Set(chosen)].map((p) => [`=== ${p.id}${mixed(p) ? " [MIXED CASES]" : ""} ${p.items.length} items ${p.inputTokens} tokens, ${p.pairs.length} pairs\n${p.issue}`,
    ...p.items.map((k) => { const i = byKey.get(k)!; return `-- ${k} (${i.session})\n   ${i.question.slice(0, 200)}\n   ${i.answer.slice(0, 300)}`; })].join("\n")).join("\n\n");
}
