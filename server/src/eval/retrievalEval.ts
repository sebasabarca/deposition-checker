// The independent retrieval evaluator: scores any retrieval variant written in the frozen benchmark format
// (server/src/retrieve/frozen.ts) against labelled pairs, without a database or a model. Pure functions only;
// scripts/retrieval-eval.ts reads the files and prints. It also checks a frozen corpus's integrity and turns
// cross-witness labels into frozen pairs (held-out pairs, an independent corpus's fixture definition).
//
// Rules: controls (expected no_conflict) and exploratory pairs are reported apart from the targets and never
// counted as negatives or false positives; results are counts ("2 of 3"), never percentages.

import { buildPool, fuseRankings, pairKey, rankIn, type CandidatePool, type FrozenBenchmark, type FrozenItem, type FrozenPair, type PathNeighbours, type PathRankings, type Ranked } from "../retrieve/frozen";
import type { CrossLabelFile } from "./crossLabels";
import type { EvidenceFixture } from "./evidenceFixtures";

export const FUSION_K = 60; // as the baseline pools (frozen.ts fuseRankings default)
export const PER_ITEM_BUDGETS = [1, 2, 3, 5, 10, 20, 50] as const;
export const POOL_SIZE_BUDGETS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000] as const;
export const SAMPLE_SIZE = 25;
const EXCERPT_CHARS = 160;

export type PairKind = "target" | "control" | "exploratory";
// target: review_worthy, conflict, conflict_needs_context. control: control, no_conflict. exploratory: never scored.
export const kindOf = (category: string): PairKind => (category === "control" || category === "no_conflict" ? "control" : category === "exploratory" ? "exploratory" : "target");
export const KINDS: readonly PairKind[] = ["target", "control", "exploratory"];

// ---------- Paths: full rankings and depth-limited neighbours, per query ----------

export type PathSource = { path: string; depth: number | null; rankings: Record<string, Ranked[]>; neighbours: Record<string, Ranked[]> };

// One source per path name: a path may come as full rankings (labelled sides only), neighbours (every item), or both.
export function collectPaths(rankings: readonly PathRankings[], neighbours: readonly PathNeighbours[]): PathSource[] {
  const out = new Map<string, PathSource>();
  const get = (path: string) => out.get(path) ?? out.set(path, { path, depth: null, rankings: {}, neighbours: {} }).get(path)!;
  for (const r of rankings) Object.assign(get(r.path).rankings, r.rankings);
  for (const n of neighbours) { const s = get(n.path); s.depth = n.depth; Object.assign(s.neighbours, n.neighbours); }
  return [...out.values()];
}

// A rank, and what list it came from: "full" (a null rank means the path never retrieved it), "depth" (a null
// rank means beyond the path's depth), or "none" (the path has no list for any query of that side).
export type RankCell = { rank: number | null; from: "full" | "depth" | "none" };

// The best (smallest) rank of any `targets` item from any of `queries`, in one path's lists.
export function pathRank(p: PathSource, queries: readonly string[], targets: ReadonlySet<string>): RankCell {
  let best: number | null = null;
  let from: RankCell["from"] = "none";
  for (const q of queries) {
    const full = p.rankings[q];
    const list = full ?? p.neighbours[q];
    if (!list) continue;
    if (from !== "full") from = full ? "full" : "depth";
    const r = rankIn(list, targets);
    if (r !== null && (best === null || r < best)) best = r;
  }
  return { rank: best, from };
}

// The list fusion reads for a query: neighbours (or a full ranking cut) to `depth`, so every path is cut alike
// and fused ranks are what a pool built from these neighbours sees.
const fusionList = (p: PathSource, q: string, depth: number) => (p.neighbours[q] ?? p.rankings[q] ?? []).slice(0, depth);

export function fusedRank(paths: readonly PathSource[], queries: readonly string[], targets: ReadonlySet<string>, depth: number, k = FUSION_K): number | null {
  let best: number | null = null;
  for (const q of queries) {
    const r = rankIn(fuseRankings(paths.map((p) => fusionList(p, q, depth)), k), targets);
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

// The shallowest neighbour depth among the paths (300 when none has neighbours): every path is cut to it.
export const fusionDepthOf = (paths: readonly PathSource[]) => { const d = Math.min(...paths.map((p) => p.depth ?? Infinity)); return Number.isFinite(d) ? d : 300; };

export type Direction = { ab: RankCell; ba: RankCell };
export type PairRanks = {
  id: string; category: string; controlType?: string; kind: PairKind; left: number; right: number;
  paths: Record<string, Direction>;
  fused: { ab: number | null; ba: number | null };
  // The fused rank with each path removed.
  ablation: Record<string, { ab: number | null; ba: number | null }>;
};

// Every pair's rank in both directions: per path, fused, and fused without each path.
export function rankPairs(pairs: readonly FrozenPair[], paths: readonly PathSource[], depth = fusionDepthOf(paths)): PairRanks[] {
  return pairs.map((pair) => {
    const [L, R] = [new Set(pair.left), new Set(pair.right)];
    const fused = (ps: readonly PathSource[]) => ({ ab: fusedRank(ps, pair.left, R, depth), ba: fusedRank(ps, pair.right, L, depth) });
    return {
      id: pair.id, category: pair.category, controlType: pair.controlType, kind: kindOf(pair.category), left: pair.left.length, right: pair.right.length,
      paths: Object.fromEntries(paths.map((p) => [p.path, { ab: pathRank(p, pair.left, R), ba: pathRank(p, pair.right, L) }])),
      fused: fused(paths),
      ablation: paths.length > 1 ? Object.fromEntries(paths.map((p) => [p.path, fused(paths.filter((x) => x !== p))])) : {},
    };
  });
}

// ---------- Pools ----------

const joins = (pair: FrozenPair) => { const [L, R] = [new Set(pair.left), new Set(pair.right)]; return (a: string, b: string) => (L.has(a) && R.has(b)) || (L.has(b) && R.has(a)); };

export type Counted = Record<PairKind, [held: number, of: number]>;
const countBy = (pairs: readonly { kind: PairKind }[], held: (i: number) => boolean): Counted => {
  const out = Object.fromEntries(KINDS.map((k) => [k, [0, 0]])) as Counted;
  pairs.forEach((p, i) => { out[p.kind][1]++; if (held(i)) out[p.kind][0]++; });
  return out;
};

export type PoolPair = { id: string; kind: PairKind; held: boolean; poolRank: number | null; perItemRank: number | null; ranks: Record<string, [number | null, number | null]> | null };
export type PoolReport = {
  name: string; perItem: number; paths: string[]; candidates: number; crossSession: boolean;
  pairs: PoolPair[];
  // Labelled pairs held if each item kept only its first `b` candidates in pool order / if the pool were cut to its
  // first `n` (the last budget is the whole pool).
  perItemBudgets: Record<number, Counted>;
  sizeBudgets: Record<number, Counted>;
  // Candidates only one path ranked at all (either direction), per path: a pool-agnostic contribution measure.
  solePath: Record<string, number>;
};

// A pool's order is its array order (frozen pools are sorted by fused score). A pair's pool rank is its first
// joining candidate's position; its per-item rank is that candidate's position among its own item's candidates.
export function evaluatePool(pool: CandidatePool, pairs: readonly FrozenPair[], sessionOf?: ReadonlyMap<string, string>): PoolReport {
  const join = pairs.map(joins);
  const found = pairs.map(() => ({ poolRank: null as number | null, perItemRank: null as number | null, ranks: null as PoolPair["ranks"] }));
  const count = new Map<string, number>();
  const solePath: Record<string, number> = Object.fromEntries(pool.paths.map((p) => [p, 0]));
  let crossSession = true;
  pool.candidates.forEach((c, i) => {
    const ca = (count.get(c.a) ?? 0) + 1;
    const cb = (count.get(c.b) ?? 0) + 1;
    count.set(c.a, ca).set(c.b, cb);
    if (sessionOf && sessionOf.get(c.a) === sessionOf.get(c.b)) crossSession = false;
    const ranked = Object.entries(c.ranks ?? {}).filter(([, [ab, ba]]) => ab !== null || ba !== null);
    if (ranked.length === 1) solePath[ranked[0][0]] = (solePath[ranked[0][0]] ?? 0) + 1;
    join.forEach((j, p) => {
      if (!j(c.a, c.b)) return;
      const f = found[p];
      if (f.poolRank === null) { f.poolRank = i + 1; f.ranks = c.ranks ?? null; }
      const r = Math.min(ca, cb);
      if (f.perItemRank === null || r < f.perItemRank) f.perItemRank = r;
    });
  });
  const out: PoolPair[] = pairs.map((p, i) => ({ id: p.id, kind: kindOf(p.category), held: found[i].poolRank !== null, ...found[i] }));
  return {
    name: pool.name, perItem: pool.perItem, paths: pool.paths, candidates: pool.candidates.length, crossSession, pairs: out,
    perItemBudgets: Object.fromEntries(PER_ITEM_BUDGETS.map((b) => [b, countBy(out, (i) => out[i].perItemRank !== null && out[i].perItemRank! <= b)])),
    sizeBudgets: Object.fromEntries([...POOL_SIZE_BUDGETS.filter((n) => n < pool.candidates.length), pool.candidates.length].map((n) => [n, countBy(out, (i) => out[i].poolRank !== null && out[i].poolRank! <= n)])),
    solePath,
  };
}

export type PoolAblation = { path: string; candidates: number; lost: number; gained: number; lostPairs: string[]; gainedPairs: string[] };
export type PoolContribution = { reproducible: boolean; note: string; ablations: PoolAblation[] };

// Leave-one-path-out for a pool that is each item's fused top `perItem` over neighbours we hold: rebuilt without
// each path, the candidates lost are those the pool holds only because of that path. Only run when rebuilding
// with every path gives the same candidate set (otherwise the pool was made some other way and this says so).
export function poolContribution(pool: CandidatePool, paths: readonly PathSource[], pairs: readonly FrozenPair[]): PoolContribution {
  const neighbours = pool.paths.map((name) => paths.find((p) => p.path === name && Object.keys(p.neighbours).length));
  if (neighbours.some((n) => !n)) return { reproducible: false, note: "not every path of the pool has neighbours here", ablations: [] };
  const asNeighbours = (ps: readonly PathSource[]): PathNeighbours[] => ps.map((p) => ({ path: p.path, depth: p.depth ?? 0, neighbours: p.neighbours }));
  const ids = (p: CandidatePool) => new Set(p.candidates.map((c) => pairKey(c.a, c.b)));
  const full = ids(pool);
  const rebuilt = ids(buildPool(pool.name, asNeighbours(neighbours as PathSource[]), pool.perItem));
  if (rebuilt.size !== full.size || [...full].some((k) => !rebuilt.has(k))) return { reproducible: false, note: `rebuilding from the paths' neighbours gives ${rebuilt.size} candidates, not the pool's ${full.size}`, ablations: [] };
  const heldIn = (set: ReadonlySet<string>) => pairs.filter((pair) => pair.left.some((a) => pair.right.some((b) => set.has(pairKey(a, b))))).map((p) => p.id);
  const before = new Set(heldIn(full));
  return {
    reproducible: true, note: "rebuilt exactly; each ablation rebuilds the pool without one path, same per-item budget",
    ablations: (neighbours as PathSource[]).map((drop) => {
      const without = ids(buildPool(pool.name, asNeighbours((neighbours as PathSource[]).filter((p) => p !== drop)), pool.perItem));
      const after = new Set(heldIn(without));
      return { path: drop.path, candidates: without.size, lost: [...full].filter((k) => !without.has(k)).length, gained: [...without].filter((k) => !full.has(k)).length, lostPairs: [...before].filter((id) => !after.has(id)), gainedPairs: [...after].filter((id) => !before.has(id)) };
    }),
  };
}

// The pool's best-ranked candidates that join no labelled pair (of any kind), with a short excerpt of each side,
// for a person to inspect. Excerpts quote testimony: the caller writes them only under data/raw/.
export function unlabelledSample(pool: CandidatePool, pairs: readonly FrozenPair[], items: ReadonlyMap<string, FrozenItem>, n = SAMPLE_SIZE) {
  const join = pairs.map(joins);
  const excerpt = (key: string) => { const i = items.get(key); return i ? (i.answer || i.question).replace(/\s+/g, " ").slice(0, EXCERPT_CHARS) : null; };
  const out = [];
  for (let i = 0; i < pool.candidates.length && out.length < n; i++) {
    const c = pool.candidates[i];
    if (join.some((j) => j(c.a, c.b))) continue;
    out.push({ poolRank: i + 1, a: c.a, b: c.b, fused: c.fused, ranks: c.ranks, excerptA: excerpt(c.a), excerptB: excerpt(c.b) });
  }
  return out;
}

// ---------- Integrity ----------

export type Problem = { check: string; detail: string };

export function checkManifest(manifestFiles: Record<string, string>, actual: Record<string, string | null>): Problem[] {
  const out: Problem[] = [];
  for (const [name, sha] of Object.entries(manifestFiles)) {
    if (actual[name] === undefined || actual[name] === null) out.push({ check: "manifest", detail: `${name} is listed but missing` });
    else if (actual[name] !== sha) out.push({ check: "manifest", detail: `${name}: SHA-256 ${actual[name]} is not the manifest's ${sha}` });
  }
  for (const name of Object.keys(actual)) if (!(name in manifestFiles) && name !== "manifest.json") out.push({ check: "manifest", detail: `${name} is not in the manifest` });
  return out;
}

const posValue = (p: string) => { const [page, line] = p.split(":").map(Number); return page * 1e6 + line; };

// Each labelled side's items are exactly the items of that document with a position inside the side's range.
export function checkSides(items: readonly FrozenItem[], fixture: Pick<EvidenceFixture, "items">, benchmark: FrozenBenchmark): Problem[] {
  const out: Problem[] = [];
  const byId = new Map(benchmark.pairs.map((p) => [p.id, p]));
  for (const x of fixture.items) {
    const pair = byId.get(x.id);
    if (!pair) { out.push({ check: "sides", detail: `${x.id} is in the fixture but not the benchmark` }); continue; }
    if (pair.category !== x.category || pair.controlType !== x.controlType) out.push({ check: "sides", detail: `${x.id}: category ${pair.category}/${pair.controlType} is not the fixture's ${x.category}/${x.controlType}` });
    x.sides.forEach((s, i) => {
      const [from, to] = [posValue(s.from), posValue(s.to)];
      const expected = items.filter((it) => it.document === s.document && it.positions.some((p) => posValue(p) >= from && posValue(p) <= to)).map((it) => it.key).sort();
      const got = [...(i === 0 ? pair.left : pair.right)].sort();
      if (JSON.stringify(expected) !== JSON.stringify(got)) out.push({ check: "sides", detail: `${x.id} side ${i + 1} (${s.document} ${s.from}-${s.to}): benchmark has [${got}], the range holds [${expected}]` });
    });
  }
  for (const p of benchmark.pairs) if (!fixture.items.some((x) => x.id === p.id)) out.push({ check: "sides", detail: `${p.id} is in the benchmark but not the fixture` });
  return out;
}

// No labelled pair within one session; no ranking or neighbour list reaching into the query's own session.
export function checkSessions(items: readonly FrozenItem[], pairs: readonly FrozenPair[], paths: readonly PathSource[]): Problem[] {
  const out: Problem[] = [];
  const session = new Map(items.map((i) => [i.key, i.session]));
  for (const p of pairs) {
    const unknown = [...p.left, ...p.right].filter((k) => !session.has(k));
    if (unknown.length) out.push({ check: "sessions", detail: `${p.id}: unknown items ${unknown.join(", ")}` });
    const shared = [...new Set(p.left.map((k) => session.get(k)))].filter((s) => p.right.some((k) => session.get(k) === s));
    if (shared.length) out.push({ check: "sessions", detail: `${p.id}: both sides in session ${shared.join(", ")}` });
  }
  for (const p of paths) {
    let same = 0, unknown = 0;
    for (const lists of [p.rankings, p.neighbours]) for (const [q, list] of Object.entries(lists)) for (const [k] of list) { const s = session.get(k); if (s === undefined) unknown++; else if (s === session.get(q)) same++; }
    if (same) out.push({ check: "sessions", detail: `${p.path}: ${same} ranked entries are in the query's own session` });
    if (unknown) out.push({ check: "sessions", detail: `${p.path}: ${unknown} ranked entries are not corpus items` });
  }
  return out;
}

// A document read as one or two exchanges (one item holding at least half its testimony lines, of 20 or more):
// its pairs are found by a whole session, not an answer. Returns the problems and those items' keys.
export function checkSegmentation(items: readonly FrozenItem[]): { problems: Problem[]; keys: Set<string> } {
  const byDoc = new Map<string, FrozenItem[]>();
  for (const i of items) byDoc.set(i.document, [...(byDoc.get(i.document) ?? []), i]);
  const problems: Problem[] = [];
  const keys = new Set<string>();
  for (const [doc, its] of byDoc) {
    const total = its.reduce((n, i) => n + i.positions.length, 0);
    const big = its.reduce((a, b) => (b.positions.length > a.positions.length ? b : a));
    if (total < 20 || big.positions.length * 2 < total) continue;
    keys.add(big.key);
    problems.push({ check: "segmentation", detail: `${doc}: ${its.length} item(s); ${big.key} holds ${big.positions.length} of ${total} lines${big.question ? "" : ", with no attorney question"}` });
  }
  return { problems, keys };
}

// Duplicate copies: two documents with one SHA-256, repeated keys, or many identical substantive answer groups
// across two documents (a file loaded twice under different names). Short identical groups ("Yes.") are normal.
export function checkDuplicates(items: readonly FrozenItem[], documents: Record<string, { sha256: string }>, minChars = 80): Problem[] {
  const out: Problem[] = [];
  const bySha = new Map<string, string[]>();
  for (const [k, d] of Object.entries(documents)) bySha.set(d.sha256, [...(bySha.get(d.sha256) ?? []), k]);
  for (const [sha, ks] of bySha) if (ks.length > 1) out.push({ check: "duplicates", detail: `documents ${ks.join(", ")} share SHA-256 ${sha}` });
  const keys = new Set<string>();
  for (const i of items) { if (keys.has(i.key)) out.push({ check: "duplicates", detail: `item key ${i.key} repeats` }); keys.add(i.key); }
  const docsWithItems = new Set(items.map((i) => i.document));
  for (const d of docsWithItems) if (!(d in documents)) out.push({ check: "duplicates", detail: `items name document ${d}, which the manifest doesn't list` });
  for (const d of Object.keys(documents)) if (!docsWithItems.has(d)) out.push({ check: "duplicates", detail: `document ${d} has no items` });
  const textDocs = new Map<string, Set<string>>();
  for (const i of items) { const t = `${i.question} ${i.answer}`.replace(/\s+/g, " ").trim(); if (t.length >= minChars) textDocs.set(t, (textDocs.get(t) ?? new Set()).add(i.document)); }
  const shared = new Map<string, number>();
  for (const ds of textDocs.values()) if (ds.size > 1) { const k = [...ds].sort().join(" & "); shared.set(k, (shared.get(k) ?? 0) + 1); }
  for (const [k, n] of shared) out.push({ check: "duplicates", detail: `${n} substantive answer groups (>= ${minChars} chars) appear word for word in ${k}` });
  return out;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

// An item's question and answer words all come from the source lines at its positions (speaker labels aside).
export function checkItemText(item: FrozenItem, source: ReadonlyMap<string, string>): string | null {
  const missing = item.positions.filter((p) => !source.has(p));
  if (missing.length) return `${item.key}: positions ${missing.join(", ")} are not in the source`;
  const have = new Set(words(item.positions.map((p) => source.get(p)).join(" ")));
  const extra = [...new Set(words(`${item.question} ${item.answer}`))].filter((w) => !have.has(w));
  return extra.length ? `${item.key}: words not in its source lines: ${extra.slice(0, 8).join(", ")}` : null;
}

// ---------- Labels into frozen pairs ----------

export type Skipped = { id: string; reason: string };
export type HeldOutPair = FrozenPair & { expected: string; topic: string; unmatchedLines?: string[] };

// Line-anchored cross labels resolved to frozen items: every item holding a named statement. A side whose lines
// no item holds is reported, never guessed; pairs already in `exclude` (the design benchmark) are listed as such.
export function heldOutPairs(labels: CrossLabelFile, items: readonly FrozenItem[], exclude: ReadonlySet<string>, source: string): { pairs: HeldOutPair[]; skipped: Skipped[] } {
  const pairs: HeldOutPair[] = [];
  const skipped: Skipped[] = [...(labels.exclusions ?? []).map((x) => ({ id: x.id, reason: `excluded by the label file: ${x.reason}` }))];
  const byDoc = new Map<string, FrozenItem[]>();
  for (const i of items) byDoc.set(i.document, [...(byDoc.get(i.document) ?? []), i]);
  for (const c of labels.comparisons) for (const p of c.pairs) {
    if (exclude.has(p.id)) { skipped.push({ id: p.id, reason: "already in the design benchmark (not held out)" }); continue; }
    const sides: string[][] = [];
    const unmatched: string[] = [];
    let reason: string | null = null;
    for (const side of [p.a, p.b]) {
      const docItems = byDoc.get(side.document);
      if (!docItems) { reason = `document ${side.document} is not in the corpus`; break; }
      if (!("lines" in side)) { reason = `side ${side.document} is anchored by a phrase; this corpus resolves line anchors only`; break; }
      const pages = new Set(docItems.flatMap((i) => i.positions.map((x) => x.split(":")[0])));
      if (side.part === undefined && pages.size > 1) { reason = `${side.document} has several statement runs and the label names no part`; break; }
      const page = side.part !== undefined ? String(side.part) : [...pages][0];
      const keys = new Set<string>();
      for (const line of side.lines) {
        const pos = `${page}:${line}`;
        const hit = docItems.filter((i) => i.positions.includes(pos));
        if (!hit.length) unmatched.push(`${side.document} ${pos}`);
        hit.forEach((i) => keys.add(i.key));
      }
      if (!keys.size) { reason = `no item holds any of ${side.document} ${page}:${side.lines.join(",")}`; break; }
      sides.push([...keys].sort());
    }
    if (reason) { skipped.push({ id: p.id, reason }); continue; }
    pairs.push({ id: p.id, category: p.expected, expected: p.expected, topic: p.topic, source, left: sides[0], right: sides[1], ...(unmatched.length ? { unmatchedLines: unmatched } : {}) });
  }
  return { pairs, skipped };
}

const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
export type StoredLine = { page: number; line: number; text: string; role: string };

// Where an exact phrase lies in one document's stored lines (in order), across wrapped lines and page breaks:
// found exactly once in the whole document, or an error saying why not. Never a nearest match.
export function locatePhrase(phrase: string, lines: readonly StoredLine[]): { from: string; to: string; roles: string[] } | { error: string } {
  const texts = lines.map((l) => squash(l.text));
  const starts: number[] = [];
  let at = 0;
  for (const t of texts) { starts.push(at); at += t.length + 1; }
  const all = texts.join(" ");
  const needle = squash(phrase);
  const hits: number[] = [];
  for (let i = all.indexOf(needle); i >= 0; i = all.indexOf(needle, i + 1)) hits.push(i);
  if (hits.length !== 1) return { error: hits.length ? `found ${hits.length} times` : "not found" };
  const end = hits[0] + needle.length - 1;
  const lineAt = (offset: number) => starts.filter((s) => s <= offset).length - 1; // starts ascend
  const [first, last] = [lineAt(hits[0]), lineAt(end)];
  const run = lines.slice(first, last + 1);
  return { from: `${run[0].page}:${run[0].line}`, to: `${run.at(-1)!.page}:${run.at(-1)!.line}`, roles: [...new Set(run.map((l) => l.role))] };
}

export type FixtureDocument = EvidenceFixture["documents"][string];
// A fixture item for the frozen benchmark: its labelled sides as page:line ranges, plus the label's expected.
export type CorpusFixture = EvidenceFixture & { version: 1; set: string; about: string; unresolved: Skipped[]; items: (EvidenceFixture["items"][number] & { label: string })[] };

// Phrase-anchored cross labels into an evidence fixture: all documents in one corpus, each its own session.
export function fixtureFromCrossLabels(labels: CrossLabelFile, root: string, linesOf: ReadonlyMap<string, readonly StoredLine[]>, schemes: ReadonlyMap<string, string>, labelPath: string): CorpusFixture {
  const documents: Record<string, FixtureDocument> = {};
  for (const [key, d] of Object.entries(labels.documents)) documents[key] = { sha256: d.sha256, witness: d.witness, takenOn: d.takenOn, scheme: schemes.get(key) ?? "unrecognized", local: `${root}/${d.file}`, loader: "text", session: key, part: 1 };
  const items: CorpusFixture["items"] = [];
  const unresolved: Skipped[] = [];
  for (const c of labels.comparisons) for (const p of c.pairs) {
    const sides = [];
    const errors: string[] = [];
    for (const [name, side] of [["a", p.a], ["b", p.b]] as const) {
      if (!("phrase" in side)) { errors.push(`side ${name} is anchored by lines, not a phrase`); continue; }
      const lines = linesOf.get(side.document);
      if (!lines) { errors.push(`side ${name}: ${side.document} has no stored lines`); continue; }
      const r = locatePhrase(side.phrase, lines);
      if ("error" in r) { errors.push(`side ${name} (${side.document}): phrase ${r.error}`); continue; }
      if (r.roles.some((role) => role !== "witness")) { errors.push(`side ${name} (${side.document} ${r.from}-${r.to}): lines read as ${r.roles.join("/")}, not only the witness`); continue; }
      sides.push({ document: side.document, from: r.from, to: r.to, search: side.phrase });
    }
    if (errors.length) { unresolved.push({ id: p.id, reason: errors.join("; ") }); continue; }
    items.push({ id: p.id, category: p.expected, label: `${labels.set}#${p.id}`, sides });
  }
  return { version: 1, set: `${labels.set}-fixture`, about: `Every transcript of ${labelPath} in one corpus (each its own session), with each labelled pair's phrases resolved to page:line ranges of the stored lines (exact, unique matches only). References only; the phrases are the label file's.`, documents, items, unresolved };
}
