// Local reranking experiment over frozen candidate pools (server/src/retrieve/frozen.ts): scores every candidate
// with local cross-encoders (server/src/retrieve/rerankModels.ts) in both directions and writes the same candidates
// in new orders, for scripts/retrieval-eval.ts. A rerank orders and defers; it never removes a candidate. No API call.
//
//   npx tsx scripts/retrieval-rerank.ts --frozen <dir> --pool <file>... --out <dir under data/raw> [--models ce,nli]
//     [--benchmark <file>...] [--context-words 30]
// Writes, per pool: scores-<pool>-<model>.json (every candidate's a->b and b->a score and windows), rerank-<pool>-<model>.json
// (model order), rerank-<pool>-rrf-<model>.json (model order fused with the pool's order), rerank-<pool>-rrf-ce-nli.json,
// agreement-<pool>.json (cross-path agreement baseline); and labelled-<model>.json: each labelled pair's score
// (best over its sides' items) with its percentile among the first pool's candidates, a diagnostic only.
// Scores are cached by both items' source hashes in <out>/cache-<model>.json.
//
// The models are fetched once, by hand, into the git-ignored data/raw/models/ (revisions pinned in rerankModels.ts):
//   R=a09144355adeed5f58c8ed011d209bf8ee5a1fec; for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt onnx/model.onnx; do
//     curl -sSfL --create-dirs -o data/raw/models/Xenova/ms-marco-MiniLM-L-6-v2/$f https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/$R/$f; done
//   echo $R > data/raw/models/Xenova/ms-marco-MiniLM-L-6-v2/REVISION
//   R=2a4f614a701367a02d51389039afc998faeda637; for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json added_tokens.json spm.model onnx/model.onnx; do
//     curl -sSfL --create-dirs -o data/raw/models/Xenova/nli-deberta-v3-xsmall/$f https://huggingface.co/Xenova/nli-deberta-v3-xsmall/resolve/$R/$f; done
//   echo $R > data/raw/models/Xenova/nli-deberta-v3-xsmall/REVISION

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pairKey, readJson, writeJson, type CandidatePool, type FrozenBenchmark, type FrozenItem } from "../server/src/retrieve/frozen";
import { agreementOrder, fuseOrders, orderByScore, pairScore, perItemOrder, relatedContradiction, rerankText, sameCandidates, RERANK_CONTEXT_WORDS } from "../server/src/retrieve/rerank";
import { RERANK_MODELS, loadReranker, type RerankModelName } from "../server/src/retrieve/rerankModels";

const { values } = parseArgs({
  options: { frozen: { type: "string" }, pool: { type: "string", multiple: true }, out: { type: "string" }, models: { type: "string" }, benchmark: { type: "string", multiple: true }, "context-words": { type: "string" } },
});
const ms = (t0: number) => Math.round(performance.now() - t0);

type Cached = { ab: number; ba: number; w: number };

async function main() {
  const { frozen, out } = values;
  if (!frozen || !out || !values.pool?.length) throw new Error("needs --frozen, --pool and --out");
  if (!path.resolve(out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out derives from testimony: it must be under data/raw/");
  mkdirSync(out, { recursive: true });
  const ctxWords = Number(values["context-words"] ?? RERANK_CONTEXT_WORDS);
  const models = (values.models?.split(",") ?? ["ce", "nli"]) as RerankModelName[];
  for (const m of models) if (!(m in RERANK_MODELS)) throw new Error(`unknown model ${m}`);
  const items = new Map(readJson<FrozenItem[]>(path.join(frozen, "items.json")).map((i) => [i.key, i]));
  const textOf = (k: string) => { const i = items.get(k); if (!i) throw new Error(`item ${k} is not in ${frozen}`); return rerankText(i, ctxWords); };
  const pools = values.pool.map((f) => ({ file: f, base: path.basename(f, ".json"), pool: readJson<CandidatePool>(f) }));
  const bench = [path.join(frozen, "benchmark.json"), ...(values.benchmark ?? [])].flatMap((f) => readJson<FrozenBenchmark>(f).pairs);
  const labelledPairs = bench.flatMap((p) => p.left.flatMap((l) => p.right.map((r) => (l < r ? [l, r] : [r, l]) as [string, string])));

  const scores: Record<string, Map<string, number>> = {};
  const meta: Record<string, unknown> = {};
  for (const m of models) {
    const cacheFile = path.join(out, `cache-${m}.json`);
    const cache: Record<string, Cached> = existsSync(cacheFile) ? readJson(cacheFile) : {};
    const keyOf = (a: string, b: string) => `${items.get(a)!.sourceHash}|${items.get(b)!.sourceHash}|${RERANK_MODELS[m].revision}|ctx${ctxWords}`;
    const all = new Map<string, [string, string]>();
    for (const p of pools) for (const c of p.pool.candidates) all.set(pairKey(c.a, c.b), [c.a, c.b]);
    for (const [a, b] of labelledPairs) all.set(pairKey(a, b), [a, b]);
    const todo = [...all.values()].filter(([a, b]) => !cache[keyOf(a, b)]);
    const t0 = performance.now();
    const model = await loadReranker(m);
    const loadMs = ms(t0);
    const t1 = performance.now();
    const CHUNK = 2000;
    for (let i = 0; i < todo.length; i += CHUNK) {
      const part = todo.slice(i, i + CHUNK);
      const ab = await model.score(part.map(([a, b]) => [textOf(a), textOf(b)]));
      const ba = await model.score(part.map(([a, b]) => [textOf(b), textOf(a)]));
      part.forEach(([a, b], j) => { cache[keyOf(a, b)] = { ab: ab[j].score, ba: ba[j].score, w: Math.max(ab[j].windows, ba[j].windows) }; });
      console.error(`${m}: ${Math.min(i + CHUNK, todo.length)}/${todo.length} pairs scored, ${ms(t1)} ms`);
      writeJson(cacheFile, cache);
    }
    if (model.fetchAttempts() !== 0) throw new Error(`${m}: ${model.fetchAttempts()} network attempts`);
    const inferMs = ms(t1);
    const s = new Map([...all].map(([id, [a, b]]) => { const c = cache[keyOf(a, b)]; return [id, pairScore([c.ab], [c.ba])]; }));
    scores[m] = s;
    const windowed = [...all.values()].filter(([a, b]) => cache[keyOf(a, b)].w > 1).length;
    meta[m] = { model: RERANK_MODELS[m].id, revision: RERANK_MODELS[m].revision, pairs: all.size, newlyScored: todo.length, loadMs, inferMs, msPerPair: todo.length ? +(inferMs / todo.length).toFixed(2) : null, windowedPairs: windowed, truncated: 0, fetchAttempts: model.fetchAttempts() };
    for (const p of pools) writeJson(path.join(out, `scores-${p.base}-${m}.json`), {
      pool: p.file, ...(meta[m] as object), contextWords: ctxWords,
      candidates: p.pool.candidates.map((c) => { const x = cache[keyOf(c.a, c.b)]; return { a: c.a, b: c.b, ab: x.ab, ba: x.ba, windows: x.w }; }),
    });
    // Diagnostic: each labelled pair's best score over its sides and its percentile among the first pool's candidates.
    const ref = pools[0].pool.candidates.map((c) => s.get(pairKey(c.a, c.b))!).sort((x, y) => x - y);
    const pct = (v: number) => { let lo = 0, hi = ref.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ref[mid] <= v) lo = mid + 1; else hi = mid; } return +(lo / ref.length).toFixed(4); };
    writeJson(path.join(out, `labelled-${m}.json`), bench.map((p) => { const best = Math.max(...p.left.flatMap((l) => p.right.map((r) => s.get(pairKey(l, r))!))); return { id: p.id, category: p.category, controlType: p.controlType, score: best, percentileInPool: pct(best), refPool: pools[0].base }; }));
  }

  const written: string[] = [];
  const put = (pool: CandidatePool, base: CandidatePool) => {
    if (!sameCandidates(base, pool)) throw new Error(`${pool.name}: reranked pool lost or gained candidates`);
    const f = path.join(out, `${pool.name}.json`);
    writeJson(f, pool);
    written.push(f);
  };
  for (const p of pools) {
    const agreement = agreementOrder(p.pool, `agreement-${p.base}`);
    put(agreement, p.pool);
    const byModel = models.map((m) => orderByScore(p.pool, scores[m], `rerank-${p.base}-${m}`));
    byModel.forEach((o, i) => {
      put(o, p.pool);
      put(fuseOrders(p.pool, [o], `rerank-${p.base}-rrf-${models[i]}`), p.pool);
      put(fuseOrders(agreement, [o], `rerank-${p.base}-rrf-agr-${models[i]}`), p.pool);
      const per = perItemOrder(p.pool, scores[models[i]], `rerank-${p.base}-${models[i]}-peritem`);
      put(per, p.pool);
      put(fuseOrders(agreement, [per], `rerank-${p.base}-rrf-agr-${models[i]}-peritem`), p.pool);
    });
    if (byModel.length > 1) put(fuseOrders(p.pool, byModel, `rerank-${p.base}-rrf-${models.join("-")}`), p.pool);
    if (scores.ce && scores.nli) {
      const related = new Map([...scores.nli].map(([id, v]) => [id, relatedContradiction(v, scores.ce.get(id)!)]));
      const o = orderByScore(p.pool, related, `rerank-${p.base}-nli-x-ce`);
      put(o, p.pool);
      put(fuseOrders(agreement, [o], `rerank-${p.base}-rrf-agr-nli-x-ce`), p.pool);
    }
  }
  const usage = process.resourceUsage();
  const run = { at: new Date().toISOString(), frozen, contextWords: ctxWords, models: meta, written, peakRssMb: Math.round(usage.maxRSS / 1024) };
  writeJson(path.join(out, `run-${pools.map((p) => p.base).join("+")}.json`), run);
  console.log(JSON.stringify(run, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
