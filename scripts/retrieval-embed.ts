// Local neural embeddings (all-MiniLM-L6-v2, server/src/retrieve/minilm.ts) as a retrieval path over a
// frozen benchmark (server/src/retrieve/frozen.ts). No API call; the model runs on this machine with
// remote loading disabled.
//
//   embed: embeds every item in each representation (cached on disk by embeddings.ts's cacheKey) and
//          writes neighbours-E_minilm_<rep>.json (PathNeighbours, depth 300, other sessions only) and
//          rankings-E_minilm_<rep>.json (PathRankings: full ranking from every labelled side's item).
//   score: per labelled pair, each path's rank of the counterpart in both directions (best over a side's
//          items), and pools of every item's fused top 5 with MiniLM replacing LSA or added as a fifth path.
//
//   npx tsx scripts/retrieval-embed.ts embed|score [--frozen data/raw/retrieval/frozen-v1] [--out data/raw/retrieval/agent-a] [--reps qac,qc,a] [--strip] [--center]
//
// The model is fetched once, by hand, into the git-ignored data/raw/models/ (revision pinned in minilm.ts):
//   for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt onnx/model.onnx; do
//     curl -sSfL --create-dirs -o data/raw/models/Xenova/all-MiniLM-L6-v2/$f https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/<revision>/$f; done
//   echo <revision> > data/raw/models/Xenova/all-MiniLM-L6-v2/REVISION
// Outputs and the cache quote or derive from testimony: --out must be under data/raw/.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPRESENTATIONS, cacheKey, centered, decodeVector, encodeVector, representationText, type Representation } from "../server/src/retrieve/embeddings";
import { buildPool, fuseRankings, poolHolds, rankIn, readJson, writeJson, type FrozenBenchmark, type FrozenItem, type PathNeighbours, type PathRankings, type Ranked } from "../server/src/retrieve/frozen";
import { denseNeighbours, type Item, type Neighbour } from "../server/src/retrieve/independent";
import { MODEL_ID, MODEL_REVISION, WINDOWING, loadMiniLM } from "../server/src/retrieve/minilm";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { frozen: { type: "string" }, out: { type: "string" }, reps: { type: "string" }, depth: { type: "string" }, center: { type: "boolean" }, strip: { type: "boolean" } } });
const FROZEN = values.frozen ?? "data/raw/retrieval/frozen-v1";
const OUT = values.out ?? "data/raw/retrieval/agent-a";
const DEPTH = Number(values.depth ?? 300);
const REPS = (values.reps?.split(",") ?? [...REPRESENTATIONS]) as Representation[];
const pathName = (rep: Representation) => `E_minilm_${rep}${values.strip ? "_s" : ""}${values.center ? "_c" : ""}`;
const ms = (t0: number) => Math.round(performance.now() - t0);

type CacheEntry = { v: string; w: number };

async function embed() {
  if (!path.resolve(OUT).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out derives from testimony: it must be under data/raw/");
  for (const r of REPS) if (!REPRESENTATIONS.includes(r)) throw new Error(`unknown representation ${r}`);
  const items = readJson<FrozenItem[]>(path.join(FROZEN, "items.json"));
  const bench = readJson<FrozenBenchmark>(path.join(FROZEN, "benchmark.json"));
  const sessions = [...new Set(items.map((i) => i.session))];
  const probe: Item[] = items.map((i, id) => ({ id, session: sessions.indexOf(i.session), question: i.question, answer: i.answer, context: i.context }));
  const index = new Map(items.map((i, k) => [i.key, k]));
  const sides = new Set(bench.pairs.flatMap((p) => [...p.left, ...p.right]).map((k) => index.get(k)!));
  const cacheDir = path.join(OUT, "cache", `${MODEL_ID.replace("/", "__")}@${MODEL_REVISION}`);
  mkdirSync(cacheDir, { recursive: true });

  const timings: Record<string, unknown> = { startedAt: new Date().toISOString() };
  let t0 = performance.now();
  const model = await loadMiniLM();
  timings.modelLoadMs = ms(t0);

  for (const rep of REPS) {
    const cacheFile = path.join(cacheDir, `${rep}.json`);
    const cache: Record<string, CacheEntry> = existsSync(cacheFile) ? readJson(cacheFile) : {};
    const texts = items.map((i) => representationText(i, rep, values.strip));
    const keys = items.map((i, k) => cacheKey({ sourceHash: i.sourceHash, model: MODEL_ID, revision: MODEL_REVISION, representation: rep, windowing: WINDOWING, text: texts[k] }));
    const missing = keys.map((k, i) => (cache[k] ? -1 : i)).filter((i) => i >= 0);
    t0 = performance.now();
    if (missing.length) {
      const { vectors, windows } = await model.embed(missing.map((i) => texts[i]));
      missing.forEach((i, j) => { cache[keys[i]] = { v: encodeVector(vectors[j]), w: windows[j] }; });
      writeJson(cacheFile, cache);
    }
    const embedMs = ms(t0);
    const raw = keys.map((k) => decodeVector(cache[k].v));
    const vectors = (values.center ? centered(raw) : raw).map((v) => Float64Array.from(v));
    const windows = keys.map((k) => cache[k].w);

    t0 = performance.now();
    const top = denseNeighbours(probe, vectors, DEPTH);
    const neighboursMs = ms(t0);
    t0 = performance.now();
    const full = denseNeighbours(probe, vectors, items.length, () => true, sides);
    const rankingsMs = ms(t0);
    // One interactive search: embed a query text the cache has not seen, rank every item against it.
    t0 = performance.now();
    const [q] = (await model.embed([`${texts[0]} `])).vectors;
    const scores = vectors.map((v) => v.reduce((s, x, j) => s + x * q[j], 0));
    scores.map((s, i) => [i, s]).sort((a, b) => b[1] - a[1]).slice(0, DEPTH);
    const oneSearchMs = ms(t0);

    const toRanked = (ns: Neighbour[]): Ranked[] => ns.map((x) => [items[x.id].key, Math.round(x.score * 1e6) / 1e6]);
    const name = pathName(rep);
    writeJson(path.join(OUT, `neighbours-${name}.json`), { path: name, depth: DEPTH, neighbours: Object.fromEntries(top.map((ns, i) => [items[i].key, toRanked(ns)])) } satisfies PathNeighbours);
    writeJson(path.join(OUT, `rankings-${name}.json`), { path: name, rankings: Object.fromEntries([...sides].map((i) => [items[i].key, toRanked(full[i])])) } satisfies PathRankings);
    timings[rep] = { cacheHits: items.length - missing.length, embedded: missing.length, embedMs, multiWindowItems: windows.filter((w) => w > 1).length, maxWindows: Math.max(...windows), windowsTotal: windows.reduce((a, b) => a + b, 0), neighboursMs, rankingsMs, oneSearchMs };
    console.log(rep, JSON.stringify(timings[rep]));
  }
  timings.fetchAttempts = model.fetchAttempts();
  timings.rssMb = Math.round(process.memoryUsage().rss / 1e6);
  writeJson(path.join(OUT, `timings-embed-${Date.now()}.json`), timings);
  console.log(JSON.stringify({ modelLoadMs: timings.modelLoadMs, fetchAttempts: timings.fetchAttempts, rssMb: timings.rssMb }));
  if (model.fetchAttempts()) throw new Error("the model library attempted network access");
}

function evaluate() {
  const bench = readJson<FrozenBenchmark>(path.join(FROZEN, "benchmark.json"));
  const baseline = readJson<PathRankings[]>(path.join(FROZEN, "rankings.json"));
  const names = readdirSync(OUT).map((f) => f.match(/^rankings-(E_minilm_\w+)\.json$/)?.[1]).filter((x): x is string => !!x).sort();
  const mine = names.map((n) => readJson<PathRankings>(path.join(OUT, `rankings-${n}.json`)));
  const best = (r: PathRankings, from: string[], to: string[]) => { const t = new Set(to); const ranks = from.map((k) => rankIn(r.rankings[k] ?? [], t)).filter((x): x is number => x !== null); return ranks.length ? Math.min(...ranks) : null; };
  const ranks: Record<string, Record<string, string>> = {};
  // Full-depth fusion of several paths' rankings from each side item, as a PathRankings of its own.
  const fused = (name: string, paths: PathRankings[]): PathRankings => ({ path: name, rankings: Object.fromEntries(Object.keys(paths[0].rankings).map((k) => [k, fuseRankings(paths.map((p) => p.rankings[k] ?? []))])) });
  const base4 = fused("fused baseline (A,B,C,D)", baseline);
  const others = baseline.filter((r) => r.path !== "B_semantic_lsa");
  const fusions = mine.flatMap((m) => [fused(`fused A,${m.path},C,D`, [...others, m]), fused(`fused A,B,C,D,${m.path}`, [...baseline, m])]);
  for (const r of [...baseline, ...mine, base4, ...fusions]) ranks[r.path] = Object.fromEntries(bench.pairs.map((p) => [p.id, `${best(r, p.left, p.right) ?? "-"}/${best(r, p.right, p.left) ?? "-"}`]));
  console.log("per-query rank of the counterpart, L->R / R->L (best over a side's items):");
  console.table(ranks);

  const load = (name: string, dir: string) => readJson<PathNeighbours>(path.join(dir, `neighbours-${name}.json`));
  const [a, b, c, d] = ["A_fulltext", "B_semantic_lsa", "C_question", "D_anchors"].map((n) => load(n, FROZEN));
  const holds = (pool: ReturnType<typeof buildPool>) => bench.pairs.filter((p) => poolHolds(pool, new Set(p.left), new Set(p.right))).map((p) => p.id).join(",");
  const rows: Record<string, { size: number; holds: string }> = {};
  const base = buildPool("baseline", [a, b, c, d], 5);
  rows.baseline = { size: base.candidates.length, holds: holds(base) };
  for (const rep of names) {
    const e = load(rep, OUT);
    const replace = buildPool(`replace-lsa-${rep}`, [a, e, c, d], 5);
    const add = buildPool(`add-fifth-${rep}`, [a, b, c, d, e], 5);
    rows[`replace LSA with ${rep}`] = { size: replace.candidates.length, holds: holds(replace) };
    rows[`add ${rep} as fifth`] = { size: add.candidates.length, holds: holds(add) };
  }
  console.log("pools of every item's fused top 5:");
  console.table(rows);
  writeJson(path.join(OUT, `score-${Date.now()}.json`), { ranks, pools: rows });
}

const run = positionals[0] === "embed" ? embed : positionals[0] === "score" ? async () => evaluate() : null;
if (!run) { console.error("usage: retrieval-embed.ts embed|score [--frozen dir] [--out dir] [--reps qac,qc,a] [--strip] [--center]"); process.exitCode = 1; }
else run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
