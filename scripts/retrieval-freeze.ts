// Freezes a retrieval benchmark (server/src/retrieve/frozen.ts) from a fixture corpus: loads every file of
// the fixture definition into TEST_DATABASE_URL (which it wipes), builds the answer-group items, runs the
// baseline paths (full text, LSA, question-centered, anchors) to `--depth`, and writes items, the
// labelled pairs resolved to items, each path's full ranking from every labelled side, the baseline pool
// (each item's fused top `--per-item`) and a manifest with every file's SHA-256. Only eligible answer groups
// (server/src/evidence/eligibility.ts) are items; the others go to excluded-items.json with their class and
// reason (errata also to errata.json), and any labelled side's group that is excluded is reported. No model or API call.
//
//   npx tsx scripts/retrieval-freeze.ts --fixture data/eval/evidence-fixtures-v1.json --out data/raw/retrieval/frozen-v1 [--depth 300] [--per-item 10]
//
// Outputs quote testimony: --out must be under the git-ignored data/raw/.

import "dotenv/config";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { EVIDENCE_CLASSES } from "../server/src/evidence/eligibility";
import { loadEvidenceFixtures, missingFixtureFiles, openEvaluationDatabase, readEvidenceFixture } from "../server/src/eval/evidenceFixtures";
import { fullText, itemsOf, loadItems, type ProbeItem } from "../server/src/eval/retrievalProbe";
import { buildPool, sha256File, writeJson, type FrozenBenchmark, type FrozenItem, type PathNeighbours, type PathRankings, type Ranked } from "../server/src/retrieve/frozen";
import { anchorNeighbours, anchors, denseNeighbours, lsa, nameVocabulary, sparseNeighbours, tfidf, tokens, type Neighbour } from "../server/src/retrieve/independent";

const { values } = parseArgs({ options: { fixture: { type: "string" }, out: { type: "string" }, depth: { type: "string" }, "per-item": { type: "string" } } });

async function main() {
  if (!values.fixture || !values.out) throw new Error("needs --fixture and --out");
  if (!path.resolve(values.out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--out quotes testimony: it must be under data/raw/");
  const depth = Number(values.depth ?? 300);
  const perItem = Number(values["per-item"] ?? 10);
  const fixture = readEvidenceFixture(values.fixture);
  const missing = missingFixtureFiles(fixture);
  if (missing.length) throw new Error(`missing fixture files:\n  ${missing.join("\n  ")}`);
  const { db, pool } = await openEvaluationDatabase(process.env.TEST_DATABASE_URL);
  try {
    const l = await loadEvidenceFixtures(db, fixture);
    const { items, excluded } = await loadItems(db, l);
    const keyOf = (i: ProbeItem) => `${i.document}#${i.orderedPositions[0]}-${i.orderedPositions[i.orderedPositions.length - 1]}`;
    const frozen = (i: ProbeItem): FrozenItem => ({ key: keyOf(i), document: i.document, witness: fixture.documents[i.document].witness, session: fixture.documents[i.document].session, groupId: i.groupId, positions: i.orderedPositions, sourceHash: i.sourceHash, question: i.question, answer: i.answer, context: i.context, eligibility: i.eligibility });
    const frozenItems = items.map(frozen);
    const excludedItems = excluded.map(frozen);
    if (new Set([...frozenItems, ...excludedItems].map((i) => i.key)).size !== frozenItems.length + excludedItems.length) throw new Error("item keys are not unique");
    // A labelled side's answer group with testimony that is not eligible is reported, never silently lost
    // (groups with no answer at all were never items).
    const excludedSides = fixture.items.flatMap((x) => x.sides.flatMap((s, n) => [...itemsOf(excluded.map((e, k) => ({ ...e, id: k })), s)].filter((k) => excluded[k].answer.trim()).map((k) => ({ pair: x.id, side: n + 1, key: excludedItems[k].key, class: excluded[k].eligibility.class }))));
    if (excludedSides.length) console.warn(`labelled side groups excluded: ${JSON.stringify(excludedSides)}`);
    const pairs = fixture.items.map((x) => ({ id: x.id, category: x.category, controlType: x.controlType, source: values.fixture!, left: [...itemsOf(items, x.sides[0])].map((i) => frozenItems[i].key), right: [...itemsOf(items, x.sides[1])].map((i) => frozenItems[i].key) }));
    for (const p of pairs) if (!p.left.length || !p.right.length) throw new Error(`pair ${p.id} has a side with no item`);
    const benchmark: FrozenBenchmark = { corpus: path.basename(values.fixture), pairs };
    const sides = new Set(pairs.flatMap((p) => [...p.left, ...p.right]).map((k) => frozenItems.findIndex((i) => i.key === k)));

    const n = items.length;
    const context = (i: ProbeItem) => i.context.split(/\s+/).slice(-60).join(" ");
    const names = nameVocabulary(items.map((i) => `${i.text} ${i.context}`));
    const timings: Record<string, number> = {};
    const run = async (name: string, f: (k: number, rows?: ReadonlySet<number>) => Promise<Neighbour[][]> | Neighbour[][]) => {
      const t0 = performance.now();
      const top = await f(depth);
      const full = await f(n, sides);
      timings[name] = Math.round(performance.now() - t0);
      const toRanked = (ns: Neighbour[]): Ranked[] => ns.map((x) => [frozenItems[x.id].key, Math.round(x.score * 1e6) / 1e6]);
      return {
        neighbours: { path: name, depth, neighbours: Object.fromEntries(top.map((ns, i) => [frozenItems[i].key, toRanked(ns)])) } as PathNeighbours,
        rankings: { path: name, rankings: Object.fromEntries([...sides].map((i) => [frozenItems[i].key, toRanked(full[i])])) } as PathRankings,
      };
    };
    const docTokens = items.map((i) => tokens(`${i.question} ${i.answer} ${context(i)}`));
    const questionTokens = items.map((i) => tokens(`${i.question} ${context(i)}`));
    const results = [
      await run("A_fulltext", (k, rows) => fullText(pool, items, k, rows)),
      await run("B_semantic_lsa", (() => { const t = tfidf(docTokens, { maxDfShare: 0.5 }); const dense = lsa(t.vectors, t.vocabulary.length); return (k: number, rows?: ReadonlySet<number>) => denseNeighbours(items, dense, k, () => true, rows); })()),
      await run("C_question", (() => { const t = tfidf(questionTokens); return (k: number, rows?: ReadonlySet<number>) => sparseNeighbours(items, t.vectors, k, () => true, rows); })()),
      await run("D_anchors", (() => { const own = items.map((i) => anchors(i.text, names)); const ctx = items.map((i) => anchors(i.context, names)); return (k: number, rows?: ReadonlySet<number>) => anchorNeighbours(items, own, ctx, k, () => true, rows); })()),
    ];
    const t0 = performance.now();
    const pool5 = buildPool("baseline-fused-top5", results.map((r) => r.neighbours), 5);
    const poolN = buildPool(`baseline-fused-top${perItem}`, results.map((r) => r.neighbours), perItem);
    timings.pools = Math.round(performance.now() - t0);

    mkdirSync(values.out, { recursive: true });
    const files: Record<string, unknown> = { "items.json": frozenItems, "excluded-items.json": excludedItems, "errata.json": excludedItems.filter((i) => i.eligibility!.class === "errata_or_correction"), "benchmark.json": benchmark, "rankings.json": results.map((r) => r.rankings), "pool-baseline-top5.json": pool5, [`pool-baseline-top${perItem}.json`]: poolN };
    for (const r of results) files[`neighbours-${r.neighbours.path}.json`] = r.neighbours;
    for (const [name, value] of Object.entries(files)) writeJson(path.join(values.out, name), value);
    const manifest = {
      frozenOn: new Date().toISOString(), gitHead: execSync("git rev-parse HEAD").toString().trim(), gitClean: execSync("git status --porcelain -- server scripts").toString().trim() === "", fixture: values.fixture, fixtureSha256: sha256File(values.fixture),
      documents: Object.fromEntries(Object.entries(fixture.documents).map(([k, d]) => [k, { sha256: d.sha256, witness: d.witness, session: d.session }])),
      settings: { depth, perItem, lsaDims: 150, ftsTerms: 12, fusion: "reciprocal rank, k = 60, per query", contextWords: 60 },
      counts: {
        items: n, excluded: excludedItems.length, excludedSides,
        byClass: Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c, [...frozenItems, ...excludedItems].filter((i) => i.eligibility!.class === c).length])),
        pairs: pairs.length, sideItems: sides.size, poolTop5: pool5.candidates.length, [`poolTop${perItem}`]: poolN.candidates.length },
      timingsMs: timings,
      files: Object.fromEntries(Object.keys(files).map((name) => [name, sha256File(path.join(values.out!, name))])),
    };
    writeJson(path.join(values.out, "manifest.json"), manifest);
    console.log(JSON.stringify({ counts: manifest.counts, timingsMs: timings }, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
