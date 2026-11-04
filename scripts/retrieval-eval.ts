// The independent retrieval evaluator (server/src/eval/retrievalEval.ts) over a frozen corpus
// (server/src/retrieve/frozen.ts) and any extra paths and pools in the same format. No database, model or API call.
//
//   npx tsx scripts/retrieval-eval.ts --frozen <dir> [--paths <file>...] [--pools <file>...] [--benchmark <file>...]
//     [--packets <file>...] [--overhead <tokens>] [--no-frozen-pools] [--out <dir under data/raw>] [--json]
//       --paths: PathRankings or PathNeighbours files (or arrays of them), added to the frozen corpus's own paths
//       --pools: CandidatePool files, added to the frozen corpus's pool-*.json (unless --no-frozen-pools)
//       --benchmark: extra FrozenBenchmark files (e.g. held-out pairs), scored beside the corpus's benchmark.json
//       --packets: PacketSet files (issue grouping): is each labelled pair's two sides in one packet, sizes, tokens
//       --overhead: fixed input tokens per adjudication call in the token projections (default CALL_OVERHEAD_TOKENS)
//     Each pool (in its array order, so a reranked pool is scored as reordered) also gets the review burden to reach
//     each labelled pair, projected pair-by-pair tokens, and coverage by witness pair and session pair.
//       --out: writes report.json and the unlabelled sample (it quotes testimony, so it must be under data/raw/)
//   npx tsx scripts/retrieval-eval.ts --build-heldout <cross labels> --frozen <dir> --write <file>
//       line-anchored cross labels resolved to the corpus's items, minus the corpus's own benchmark pairs
//   npx tsx scripts/retrieval-eval.ts --build-fixture <cross labels> --root <dir> --write <file>
//       phrase-anchored cross labels into an evidence fixture (every transcript in one corpus), for retrieval-freeze.ts

import { readdirSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { readCrossLabelFile } from "../server/src/eval/crossLabels";
import type { EvidenceFixture } from "../server/src/eval/evidenceFixtures";
import {
  CALL_OVERHEAD_TOKENS, checkDuplicates, checkItemText, checkSegmentation, checkManifest, checkSessions, checkSides, collectPaths, evaluatePackets, evaluatePool, fixtureFromCrossLabels, fusionDepthOf, heldOutPairs, KINDS, PacketSetSchema, poolBurden, poolContribution, rankPairs, TARGET_CLASSES, tokenAssumption, unlabelledSample,
  type Counted, type PairKind, type PairRanks, type Problem, type RankCell, type StoredLine,
} from "../server/src/eval/retrievalEval";
import { schemeOf } from "../server/src/evidence/references";
import { readStoredExport } from "../server/src/eval/storedExport";
import { readDeposition } from "../server/src/ingest";
import { readJson, sha256File, writeJson, type CandidatePool, type FrozenBenchmark, type FrozenItem, type FrozenPair, type PathNeighbours, type PathRankings } from "../server/src/retrieve/frozen";

const { values } = parseArgs({
  options: {
    frozen: { type: "string" }, paths: { type: "string", multiple: true }, pools: { type: "string", multiple: true }, benchmark: { type: "string", multiple: true },
    packets: { type: "string", multiple: true }, overhead: { type: "string" }, "no-frozen-pools": { type: "boolean" }, out: { type: "string" }, json: { type: "boolean" },
    "build-heldout": { type: "string" }, "build-fixture": { type: "string" }, root: { type: "string" }, write: { type: "string" },
  },
});

const underRaw = (p: string) => path.resolve(p).startsWith(path.resolve("data/raw") + path.sep);
const lineKey = (page: number | null | undefined, line: number) => `${page ?? 0}:${line}`;

// The stored lines a document is read into, as ingestion reads them (the production reader, or a stored export).
async function storedLines(d: { local: string; loader: string; witness: string }): Promise<{ status: string; layout: string; lines: (StoredLine & { raw: string })[] }> {
  const read = d.loader === "stored-export" ? readStoredExport(d.local).read : await readDeposition(new Uint8Array(readFileSync(d.local)), undefined, undefined, d.witness);
  const lines = (read.exchanges?.lines ?? []).map((l) => ({ page: l.printedPage ?? 0, line: l.lineNo, text: l.rawText, raw: l.rawText, role: l.role }));
  return { status: read.validation.status, layout: read.validation.layout, lines };
}

async function buildHeldout() {
  if (!values.frozen || !values.write) throw new Error("--build-heldout needs --frozen and --write");
  const labels = await readCrossLabelFile(values["build-heldout"]!);
  const items = readJson<FrozenItem[]>(path.join(values.frozen, "items.json"));
  const design = readJson<FrozenBenchmark>(path.join(values.frozen, "benchmark.json"));
  const { pairs, skipped } = heldOutPairs(labels, items, new Set(design.pairs.map((p) => p.id)), values["build-heldout"]!);
  const manifest = readJson<{ files: Record<string, string> }>(path.join(values.frozen, "manifest.json"));
  writeJson(values.write, { corpus: design.corpus, heldOut: true, about: `Pairs of ${values["build-heldout"]} not used to design retrieval, resolved to the items of the frozen corpus (items.json SHA-256 ${manifest.files["items.json"]}): every item holding a labelled statement. Category is the label's expected value, unchanged.`, pairs, skipped });
  console.log(JSON.stringify({ written: values.write, pairs: pairs.map((p) => `${p.id} ${p.category} ${p.left.length}x${p.right.length}${p.unmatchedLines ? ` (unmatched ${p.unmatchedLines.join(", ")})` : ""}`), skipped }, null, 2));
}

async function buildFixture() {
  if (!values.root || !values.write) throw new Error("--build-fixture needs --root and --write");
  const labelPath = values["build-fixture"]!;
  const labels = await readCrossLabelFile(labelPath);
  const linesOf = new Map<string, StoredLine[]>();
  const reads: Record<string, string> = {};
  const schemes = new Map<string, string>();
  for (const [key, d] of Object.entries(labels.documents)) {
    const local = path.join(values.root, d.file);
    if (sha256File(local) !== d.sha256) throw new Error(`${local}: SHA-256 is not the label file's`);
    const r = await storedLines({ local, loader: "text", witness: d.witness });
    reads[key] = `${r.status}, ${r.layout}, ${r.lines.length} lines`;
    schemes.set(key, schemeOf(r.layout));
    if (r.status === "ready") linesOf.set(key, r.lines);
  }
  const fixture = fixtureFromCrossLabels(labels, values.root.replace(/\/$/, ""), linesOf, schemes, labelPath);
  writeJson(values.write, fixture);
  console.log(JSON.stringify({ written: values.write, reads, items: fixture.items.length, unresolved: fixture.unresolved }, null, 2));
}

const flat = <T>(v: T | T[]) => (Array.isArray(v) ? v : [v]);
const cell = (c: RankCell) => (c.rank !== null ? String(c.rank) : c.from === "depth" ? ">depth" : c.from === "none" ? "n/a" : "-");
const r = (n: number | null) => (n === null ? "-" : String(n));
const KIND_LABEL: Record<PairKind, string> = { target: "targets", control: "controls", exploratory: "exploratory pairs", unknown: "insufficient evidence/unknown pairs" };
const classes = (c: Record<string, [number, number]>) => TARGET_CLASSES.filter((k) => c[k]).map((k) => `${k} ${c[k][0]}/${c[k][1]}`).join(", ") || "none";
const counted = (c: Counted) => KINDS.filter((k) => c[k][1]).map((k) => `${k} ${c[k][0]}/${c[k][1]}`).join(", ");

async function evaluate() {
  const t0 = performance.now();
  const dir = values.frozen!;
  if (values.out && !underRaw(values.out)) throw new Error("--out quotes testimony: it must be under data/raw/");
  const overhead = values.overhead === undefined ? CALL_OVERHEAD_TOKENS : Number(values.overhead);
  if (!Number.isInteger(overhead) || overhead < 0) throw new Error("--overhead must be a whole number of tokens");
  const manifest = readJson<{ fixture: string; documents: Record<string, { sha256: string; witness: string; session: string }>; files: Record<string, string> }>(path.join(dir, "manifest.json"));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const problems: Problem[] = checkManifest(manifest.files, Object.fromEntries(files.map((f) => [f, sha256File(path.join(dir, f))])));
  const items = readJson<FrozenItem[]>(path.join(dir, "items.json"));
  const itemMap = new Map(items.map((i) => [i.key, i]));
  const sessionOf = new Map(items.map((i) => [i.key, i.session]));
  const design = readJson<FrozenBenchmark>(path.join(dir, "benchmark.json"));
  const benchmarks = [{ name: "benchmark.json", pairs: design.pairs }, ...(values.benchmark ?? []).map((f) => ({ name: path.basename(f), pairs: readJson<FrozenBenchmark>(f).pairs }))];
  const allPairs: FrozenPair[] = benchmarks.flatMap((b) => b.pairs);

  const rankings: PathRankings[] = [...readJson<PathRankings[]>(path.join(dir, "rankings.json"))];
  const neighbours: PathNeighbours[] = [];
  for (const f of files.filter((f) => f.startsWith("neighbours-"))) neighbours.push(readJson<PathNeighbours>(path.join(dir, f)));
  for (const f of values.paths ?? []) for (const x of flat(readJson<PathRankings | PathNeighbours | (PathRankings | PathNeighbours)[]>(f))) ("neighbours" in x ? neighbours.push(x) : rankings.push(x));
  const paths = collectPaths(rankings, neighbours);
  const tLoad = performance.now();

  // Integrity: labelled sides against the fixture's ranges, sessions, duplicates, item text against the source.
  const fixture = existsSync(manifest.fixture) ? readJson<EvidenceFixture>(manifest.fixture) : null;
  if (fixture) problems.push(...checkSides(items, fixture, design));
  else problems.push({ check: "sides", detail: `fixture ${manifest.fixture} is not here: sides not checked` });
  const segmentation = checkSegmentation(items);
  problems.push(...checkSessions(items, allPairs, paths), ...checkDuplicates(items, manifest.documents), ...segmentation.problems);
  const wholeSession = (p: { id: string }) => { const pair = allPairs.find((x) => x.id === p.id)!; return [...pair.left, ...pair.right].some((k) => segmentation.keys.has(k)); };
  const textChecked: Record<string, string> = {};
  if (fixture) for (const [key, d] of Object.entries(fixture.documents)) {
    if (!existsSync(d.local)) { problems.push({ check: "text", detail: `${key}: ${d.local} is not here` }); continue; }
    const s = await storedLines(d);
    const source = new Map<string, string>();
    for (const l of s.lines) source.set(lineKey(l.page, l.line), `${source.get(lineKey(l.page, l.line)) ?? ""} ${l.raw}`);
    const own = items.filter((i) => i.document === key);
    const bad = own.map((i) => checkItemText(i, source)).filter((x): x is string => x !== null);
    textChecked[key] = `${own.length - bad.length} of ${own.length} items match their source lines (${s.status}, ${s.layout})`;
    for (const b of bad.slice(0, 5)) problems.push({ check: "text", detail: b });
    if (bad.length > 5) problems.push({ check: "text", detail: `${key}: ${bad.length - 5} more items differ` });
  }
  const tIntegrity = performance.now();

  const depth = fusionDepthOf(paths);
  const ranked = benchmarks.map((b) => ({ name: b.name, pairs: rankPairs(b.pairs, paths, depth).map((p) => ({ ...p, wholeSessionSide: wholeSession(p) })) }));
  const tRank = performance.now();

  const poolFiles = [...(values["no-frozen-pools"] ? [] : files.filter((f) => f.startsWith("pool-")).map((f) => path.join(dir, f))), ...(values.pools ?? [])];
  const pools = poolFiles.map((f) => {
    const pool = readJson<CandidatePool>(f);
    const report = evaluatePool(pool, allPairs, sessionOf);
    return { file: f, report, burden: poolBurden(pool, report, allPairs, itemMap, overhead), contribution: poolContribution(pool, paths, allPairs), sample: unlabelledSample(pool, allPairs, itemMap) };
  });
  const packetSets = (values.packets ?? []).map((f) => {
    const parsed = PacketSetSchema.safeParse(readJson<unknown>(f));
    if (!parsed.success) throw new Error(`${f} is not a PacketSet: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { file: f, report: evaluatePackets(parsed.data, allPairs, itemMap, overhead) };
  });
  const tPools = performance.now();
  for (const p of pools) if (!p.report.crossSession) problems.push({ check: "sessions", detail: `${p.file}: a candidate joins two items of one session` });

  const usage = process.resourceUsage();
  const report = {
    frozen: dir, manifestFixture: manifest.fixture, items: items.length, fusionDepth: depth,
    paths: paths.map((p) => ({ path: p.path, depth: p.depth, fullRankingQueries: Object.keys(p.rankings).length, neighbourQueries: Object.keys(p.neighbours).length })),
    integrity: { problems, textChecked },
    benchmarks: ranked,
    tokenProjection: tokenAssumption(overhead),
    pools: pools.map((p) => ({ file: p.file, ...p.report, burden: p.burden, contribution: p.contribution, sampleKeys: p.sample.map((s) => [s.poolRank, s.a, s.b]) })),
    packets: packetSets.map((k) => ({ file: k.file, ...k.report })),
    runtime: { loadMs: Math.round(tLoad - t0), integrityMs: Math.round(tIntegrity - tLoad), rankMs: Math.round(tRank - tIntegrity), poolsMs: Math.round(tPools - tRank), totalMs: Math.round(performance.now() - t0), peakRssMb: Math.round(usage.maxRSS / 1024) },
  };
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeJson(path.join(values.out, "report.json"), report);
    writeJson(path.join(values.out, "unlabelled-sample.json"), pools.map((p) => ({ pool: p.file, candidates: p.sample })));
  }
  if (values.json) { console.log(JSON.stringify(report, null, 2)); return; }

  const out: string[] = [];
  out.push(`corpus ${dir}: ${items.length} items; paths ${report.paths.map((p) => `${p.path} (full ${p.fullRankingQueries} q, depth ${p.depth ?? "-"})`).join(", ")}; fusion RRF k=60 over depth ${depth}; token projection: ${report.tokenProjection}`);
  out.push(`integrity: ${problems.length ? `${problems.length} problem(s)` : "no problems"}`);
  for (const p of problems) out.push(`  [${p.check}] ${p.detail}`);
  for (const [k, v] of Object.entries(textChecked)) out.push(`  text ${k}: ${v}`);
  const names = paths.map((p) => p.path);
  const line = (p: PairRanks & { wholeSessionSide: boolean }) => `  ${(p.id + (p.wholeSessionSide ? "*" : "")).padEnd(9)} ${p.category.padEnd(23)} ${`${p.left}x${p.right}`.padEnd(6)} ${names.map((n) => `${cell(p.paths[n].ab)}/${cell(p.paths[n].ba)}`.padEnd(14)).join("")}${`${r(p.fused.ab)}/${r(p.fused.ba)}`.padEnd(12)}${names.length > 1 ? names.map((n) => `${r(p.ablation[n].ab)}/${r(p.ablation[n].ba)}`.padEnd(14)).join("") : ""}`;
  for (const b of ranked) {
    out.push(`\n${b.name}: ranks a->b / b->a (best over each side's items; "-" never retrieved, ">depth" beyond the neighbours' depth; * a side is a whole-session item, see segmentation)`);
    out.push(`  ${"pair".padEnd(9)} ${"category".padEnd(23)} ${"items".padEnd(6)} ${names.map((n) => n.slice(0, 13).padEnd(14)).join("")}${"fused".padEnd(12)}${names.length > 1 ? names.map((n) => `-${n}`.slice(0, 13).padEnd(14)).join("") : ""}`);
    for (const kind of KINDS) {
      const ps = b.pairs.filter((p) => p.kind === kind);
      if (!ps.length) continue;
      out.push(` ${KIND_LABEL[kind]} (${ps.length})${kind === "control" ? ": reported apart, never negatives or false positives" : ""}`);
      ps.forEach((p) => out.push(line(p)));
    }
  }
  for (const p of pools) {
    out.push(`\npool ${p.file}: ${p.report.candidates} candidates, ${p.report.perItem} per item, paths ${p.report.paths.join(", ")}`);
    for (const kind of KINDS) {
      const ps = p.report.pairs.filter((x) => x.kind === kind);
      if (ps.length) out.push(`  ${KIND_LABEL[kind]} held ${ps.filter((x) => x.held).length}/${ps.length}: ${ps.map((x) => `${x.id}${wholeSession(x) ? "*" : ""}${x.held ? `@${x.poolRank} (item rank ${x.perItemRank})` : " no"}`).join(", ")}`);
    }
    out.push(`  per-item budgets: ${Object.entries(p.report.perItemBudgets).map(([b, c]) => `${b}: ${counted(c)}`).join(" | ")}`);
    out.push(`  pool-size budgets: ${Object.entries(p.report.sizeBudgets).map(([b, c]) => `${b}: ${counted(c)}`).join(" | ")}`);
    out.push(`  candidates ranked by one path only: ${Object.entries(p.report.solePath).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (p.contribution.reproducible) for (const a of p.contribution.ablations) out.push(`  without ${a.path}: ${a.candidates} candidates; ${a.lost} held only because of it${a.lostPairs.length ? `; loses ${a.lostPairs.join(", ")}` : ""}${a.gainedPairs.length ? `; gains ${a.gainedPairs.join(", ")}` : ""}`);
    else out.push(`  leave-one-path-out: skipped (${p.contribution.note})`);
    out.push(`  targets by label class: ${classes(p.report.classes)}`);
    const b = p.burden;
    out.push(`  projected pair-by-pair adjudication: ${b.calls} calls, ${b.tokens} input tokens${b.missingItems ? ` (${b.missingItems} candidate sides are not corpus items, counted as 0)` : ""}`);
    out.push(`  burden (candidates reviewed in pool order to reach each held labelled pair; unlabelled ahead = false-positive burden; ${b.unlabelled} of ${b.calls} candidates join no labelled pair):`);
    for (const x of b.reach) out.push(`    ${x.id.padEnd(9)} ${x.kind.padEnd(11)} reviewed ${String(x.reviewed).padStart(6)}  unlabelled ahead ${String(x.unlabelledAhead).padStart(6)}  labelled ahead ${String(x.labelledAhead).padStart(3)}  tokens to reach ${x.tokensToReach}`);
    out.push(`  reviews to reach the 1st, 2nd, ... held target: ${b.targetsInOrder.join(", ") || "none held"}`);
    const rows = (rs: typeof b.byWitness, what: string) => {
      const labelled = rs.filter((x) => KINDS.some((k) => x.counts[k][1]));
      out.push(`  coverage by ${what} (${rs.length} pairs; ${rs.length - labelled.length} without labelled pairs, in the JSON report):`);
      for (const x of labelled) out.push(`    ${x.key}: ${x.candidates} candidates; ${counted(x.counts)}`);
    };
    rows(b.byWitness, "witness pair");
    rows(b.bySession, "session pair");
  }
  for (const k of packetSets) {
    const s = k.report;
    out.push(`\npackets ${k.file}: ${s.name} (source ${s.source}); ${s.packets} packets = ${s.calls} calls, ${s.distinctItems} distinct items`);
    out.push(`  items per packet min/median/max ${s.itemsPerPacket.min}/${s.itemsPerPacket.median}/${s.itemsPerPacket.max} (total ${s.itemsPerPacket.total}); listed pairs per packet ${s.pairsPerPacket.min}/${s.pairsPerPacket.median}/${s.pairsPerPacket.max} (total ${s.pairsPerPacket.total}; ${s.unlabelledListedPairs} join no labelled pair)`);
    out.push(`  tokens: stated ${s.statedTokens} (${s.tokenAssumption}); projected ${s.projectedTokens}; the same listed pairs one by one ${s.pairByPairTokens}`);
    out.push(`  labelled pairs with both sides together in a packet: ${counted(s.together)}; explicitly listed: ${counted(s.listed)}; targets by label class: ${classes(s.classes)}`);
    for (const kind of KINDS) {
      const ps = s.pairs.filter((x) => x.kind === kind);
      if (ps.length) out.push(`  ${KIND_LABEL[kind]}: ${ps.map((x) => `${x.id}${wholeSession(x) ? "*" : ""}${x.together.length ? ` in ${x.together.join("+")} (first at packet ${x.firstPacket}, ${x.tokensToReach} tokens)${x.listed.length ? "" : " not listed"}` : " no"}${x.uncovered.length ? ` [uncovered: ${x.uncovered.join("; ")}]` : ""}`).join(", ")}`);
    }
    out.push(`  uncovered entries in the set: ${s.uncovered}`);
    for (const pr of s.problems) out.push(`  [${pr.check}] ${pr.detail}`);
  }
  out.push(`\nruntime ${report.runtime.totalMs} ms (load ${report.runtime.loadMs}, integrity ${report.runtime.integrityMs}, ranks ${report.runtime.rankMs}, pools ${report.runtime.poolsMs}); peak RSS ${report.runtime.peakRssMb} MB${values.out ? `; report and unlabelled sample in ${values.out}` : ""}`);
  console.log(out.join("\n"));
}

const main = values["build-heldout"] ? buildHeldout : values["build-fixture"] ? buildFixture : values.frozen ? evaluate : async () => { throw new Error("needs --frozen <dir>, --build-heldout or --build-fixture"); };
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
