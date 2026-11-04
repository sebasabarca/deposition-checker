// The independent retrieval evaluator: scores any retrieval variant written in the frozen benchmark format
// (server/src/retrieve/frozen.ts) against labelled pairs, without a database or a model. Pure functions only;
// scripts/retrieval-eval.ts reads the files and prints. It also checks a frozen corpus's integrity and turns
// cross-witness labels into frozen pairs (held-out pairs, an independent corpus's fixture definition).
//
// Rules: controls (expected no_conflict) and exploratory pairs are reported apart from the targets and never
// counted as negatives or false positives; results are counts ("2 of 3"), never percentages.

import { buildPool, fuseRankings, pairKey, rankIn, type CandidatePool, type FrozenBenchmark, type FrozenItem, type FrozenPair, type PathNeighbours, type PathRankings, type Ranked } from "../retrieve/frozen";
import { z } from "zod";
import type { CrossLabelFile } from "./crossLabels";
import type { EvidenceFixture } from "./evidenceFixtures";

export const FUSION_K = 60; // as the baseline pools (frozen.ts fuseRankings default)
export const PER_ITEM_BUDGETS = [1, 2, 3, 5, 10, 20, 50] as const;
export const POOL_SIZE_BUDGETS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000] as const;
export const SAMPLE_SIZE = 25;
const EXCERPT_CHARS = 160;

export type PairKind = "target" | "control" | "exploratory" | "unknown";
// target: review_worthy, conflict, conflict_needs_context (and direct, inferential). control: control, no_conflict.
// exploratory: never scored. unknown: any other label (insufficient_evidence, unknown, ...), reported apart.
const TARGET_CATEGORIES = new Set(["review_worthy", "conflict", "conflict_needs_context", "direct", "inferential"]);
export const kindOf = (category: string): PairKind => (category === "control" || category === "no_conflict" ? "control" : category === "exploratory" ? "exploratory" : TARGET_CATEGORIES.has(category) ? "target" : "unknown");
export const KINDS: readonly PairKind[] = ["target", "control", "exploratory", "unknown"];
// A target's class where its label says so: a confirmed direct contradiction, inferential or needing context, or
// unclassified (review_worthy says only that it is worth a look).
export type TargetClass = "direct" | "needs_context" | "unclassified";
export const TARGET_CLASSES: readonly TargetClass[] = ["direct", "needs_context", "unclassified"];
export const targetClassOf = (category: string): TargetClass | null =>
  kindOf(category) !== "target" ? null : category === "conflict" || category === "direct" ? "direct" : category === "conflict_needs_context" || category === "inferential" ? "needs_context" : "unclassified";
const countClasses = (pairs: readonly { category: string; held: boolean }[]) => {
  const out = {} as Record<TargetClass, [held: number, of: number]>;
  for (const p of pairs) { const c = targetClassOf(p.category); if (!c) continue; const x = (out[c] ??= [0, 0]); x[1]++; if (p.held) x[0]++; }
  return out;
};

// Projected adjudication input: each item's question and answer at CHARS_PER_TOKEN, plus a fixed overhead per call.
export const CHARS_PER_TOKEN = 3;
export const CALL_OVERHEAD_TOKENS = 3500; // adjudicate-v3 system prompt + JSON schema (about 10,100 chars) at 3 chars/token, rounded up
export const itemTokens = (i: Pick<FrozenItem, "question" | "answer"> | undefined) => (i ? Math.ceil((i.question.length + i.answer.length) / CHARS_PER_TOKEN) : 0);
export const tokenAssumption = (overhead: number) => `each item's question + answer at ${CHARS_PER_TOKEN} chars/token (rounded up per item), plus ${overhead} tokens fixed overhead per call`;

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

export type PoolPair = { id: string; kind: PairKind; category: string; held: boolean; poolRank: number | null; perItemRank: number | null; ranks: Record<string, [number | null, number | null]> | null };
export type PoolReport = {
  name: string; perItem: number; paths: string[]; candidates: number; crossSession: boolean;
  pairs: PoolPair[];
  classes: Record<TargetClass, [held: number, of: number]>;
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
  const out: PoolPair[] = pairs.map((p, i) => ({ id: p.id, kind: kindOf(p.category), category: p.category, held: found[i].poolRank !== null, ...found[i] }));
  return {
    name: pool.name, perItem: pool.perItem, paths: pool.paths, candidates: pool.candidates.length, crossSession, pairs: out, classes: countClasses(out),
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

// ---------- Review burden, projected tokens and coverage by witness and session pair ----------

// A held labelled pair, reached by reviewing the pool in its array order (a reranked pool is just a reordered one):
// `reviewed` candidates up to and including it, of which `unlabelledAhead` join no labelled pair (the false-positive
// burden; controls and exploratory pairs ahead are `labelledAhead`, never false positives).
export type Reach = { id: string; kind: PairKind; category: string; reviewed: number; unlabelledAhead: number; labelledAhead: number; tokensToReach: number };
export type CoverageRow = { key: string; candidates: number; counts: Counted };
export type PoolBurden = {
  calls: number; tokens: number; overhead: number; unlabelled: number; missingItems: number;
  reach: Reach[];
  targetsInOrder: number[]; // candidates reviewed to reach the 1st, 2nd, ... held target
  byWitness: CoverageRow[]; bySession: CoverageRow[];
};

const pairOf = (a: string, b: string) => (a < b ? `${a} x ${b}` : `${b} x ${a}`);

// Candidates and labelled pairs (held/of) per unordered pair of witnesses or sessions. A labelled pair counts under
// every key its sides' items give (normally one).
export function coverageRows(candidates: readonly { a: string; b: string }[], pairs: readonly FrozenPair[], held: readonly boolean[], groupOf: (key: string) => string): CoverageRow[] {
  const rows = new Map<string, CoverageRow>();
  const row = (key: string) => rows.get(key) ?? rows.set(key, { key, candidates: 0, counts: Object.fromEntries(KINDS.map((k) => [k, [0, 0]])) as Counted }).get(key)!;
  for (const c of candidates) row(pairOf(groupOf(c.a), groupOf(c.b))).candidates++;
  pairs.forEach((p, i) => {
    const keys = new Set(p.left.flatMap((a) => p.right.map((b) => pairOf(groupOf(a), groupOf(b)))));
    for (const k of keys) { const x = row(k).counts[kindOf(p.category)]; x[1]++; if (held[i]) x[0]++; }
  });
  return [...rows.values()].sort((x, y) => y.candidates - x.candidates || x.key.localeCompare(y.key));
}

export function poolBurden(pool: CandidatePool, report: PoolReport, pairs: readonly FrozenPair[], items: ReadonlyMap<string, FrozenItem>, overhead = CALL_OVERHEAD_TOKENS): PoolBurden {
  const join = pairs.map(joins);
  const unlabelledBefore: number[] = [];
  const tokensThrough: number[] = [];
  let unlabelled = 0, tokens = 0, missingItems = 0;
  for (const c of pool.candidates) {
    unlabelledBefore.push(unlabelled);
    if (!join.some((j) => j(c.a, c.b))) unlabelled++;
    for (const k of [c.a, c.b]) if (!items.has(k)) missingItems++;
    tokens += itemTokens(items.get(c.a)) + itemTokens(items.get(c.b)) + overhead;
    tokensThrough.push(tokens);
  }
  const reach = report.pairs.filter((p) => p.poolRank !== null).map((p) => {
    const i = p.poolRank! - 1;
    return { id: p.id, kind: p.kind, category: p.category, reviewed: i + 1, unlabelledAhead: unlabelledBefore[i], labelledAhead: i - unlabelledBefore[i], tokensToReach: tokensThrough[i] };
  }).sort((a, b) => a.reviewed - b.reviewed);
  const held = report.pairs.map((p) => p.held);
  const attr = (f: (i: FrozenItem) => string) => (k: string) => { const i = items.get(k); return i ? f(i) : "?"; };
  return {
    calls: pool.candidates.length, tokens, overhead, unlabelled, missingItems, reach,
    targetsInOrder: reach.filter((r) => r.kind === "target").map((r) => r.reviewed),
    byWitness: coverageRows(pool.candidates, pairs, held, attr((i) => i.witness)),
    bySession: coverageRows(pool.candidates, pairs, held, attr((i) => i.session)),
  };
}

// ---------- Within-case evaluation ----------

// A case for each document: the pattern's first capture group, else its whole match, else the document itself.
// An evaluation option only (a corpus holding several unrelated cases), never a retrieval change.
export const caseOfDocument = (pattern: RegExp) => (document: string) => { const m = document.match(pattern); return m ? (m[1] ?? m[0]) : document; };

// The pool's candidates whose two items are of one case, in the pool's order.
export function withinCase(pool: CandidatePool, items: ReadonlyMap<string, FrozenItem>, caseOf: (document: string) => string): CandidatePool {
  const c = (k: string) => { const i = items.get(k); return i ? caseOf(i.document) : `?${k}`; };
  return { ...pool, name: `${pool.name} [within-case]`, candidates: pool.candidates.filter((x) => c(x.a) === c(x.b)) };
}

// ---------- Corpus versions ----------

export type DocumentDiff = { document: string; before: number; after: number; same: number; changed: number; removed: number; added: number; excludedAfter: number };
export type RemovedFate = Record<string, number>; // "excluded: <class>", "re-segmented", "no longer read"
export type PairMapping = {
  id: string; status: "unchanged" | "remapped" | "added" | "removed"; categoryBefore: string | null; categoryAfter: string | null;
  left: [before: string[], after: string[]]; right: [before: string[], after: string[]];
};
export type CorpusDiff = { documentsAdded: string[]; documentsRemoved: string[]; documents: DocumentDiff[]; totals: Omit<DocumentDiff, "document">; removedFate: RemovedFate; pairs: PairMapping[] };

const sameItem = (a: FrozenItem, b: FrozenItem) => a.sourceHash === b.sourceHash && a.question === b.question && a.answer === b.answer && a.positions.join() === b.positions.join();

// Two versions of a corpus, item by item (by key: same, changed text or span, removed, added) and each removed
// item's fate (its lines now in an excluded group, in other items, or not read at all); and every labelled pair's
// side mapping by id. Pairs are matched by id; a category change is shown, never hidden.
export function diffCorpora(before: readonly FrozenItem[], after: readonly FrozenItem[], excludedAfter: readonly FrozenItem[], pairsBefore: readonly FrozenPair[], pairsAfter: readonly FrozenPair[]): CorpusDiff {
  const B = new Map(before.map((i) => [i.key, i]));
  const A = new Map(after.map((i) => [i.key, i]));
  const docs = [...new Set([...before, ...after, ...excludedAfter].map((i) => i.document))].sort();
  const where = new Map<string, FrozenItem>();
  for (const i of [...after, ...excludedAfter]) for (const p of i.positions) where.set(`${i.document}@${p}`, i);
  const removedFate: RemovedFate = {};
  const documents = docs.map((document) => {
    const b = before.filter((i) => i.document === document);
    const a = after.filter((i) => i.document === document);
    const d: DocumentDiff = { document, before: b.length, after: a.length, same: 0, changed: 0, removed: 0, added: a.filter((i) => !B.has(i.key)).length, excludedAfter: excludedAfter.filter((i) => i.document === document).length };
    for (const i of b) {
      const now = A.get(i.key);
      if (now) { if (sameItem(i, now)) d.same++; else d.changed++; continue; }
      d.removed++;
      const targets = i.positions.map((p) => where.get(`${document}@${p}`)).filter((x): x is FrozenItem => !!x);
      // Its lines now in eligible items (re-segmented, maybe partly excluded), only in excluded groups, or nowhere.
      const ex = targets.find((t) => t.eligibility && !t.eligibility.eligible);
      const fate = targets.some((t) => A.has(t.key)) ? (ex ? "re-segmented, partly excluded" : "re-segmented") : ex ? `excluded: ${ex.eligibility!.class}` : "no longer read";
      removedFate[fate] = (removedFate[fate] ?? 0) + 1;
    }
    return d;
  });
  const totals = documents.reduce((t, d) => ({ before: t.before + d.before, after: t.after + d.after, same: t.same + d.same, changed: t.changed + d.changed, removed: t.removed + d.removed, added: t.added + d.added, excludedAfter: t.excludedAfter + d.excludedAfter }), { before: 0, after: 0, same: 0, changed: 0, removed: 0, added: 0, excludedAfter: 0 });
  const PB = new Map(pairsBefore.map((p) => [p.id, p]));
  const PA = new Map(pairsAfter.map((p) => [p.id, p]));
  const ids = [...new Set([...PB.keys(), ...PA.keys()])];
  const sorted = (xs?: readonly string[]) => [...(xs ?? [])].sort();
  const pairs = ids.map((id): PairMapping => {
    const [b, a] = [PB.get(id), PA.get(id)];
    const left: [string[], string[]] = [sorted(b?.left), sorted(a?.left)];
    const right: [string[], string[]] = [sorted(b?.right), sorted(a?.right)];
    const status = !b ? "added" : !a ? "removed" : left[0].join() === left[1].join() && right[0].join() === right[1].join() ? "unchanged" : "remapped";
    return { id, status, categoryBefore: b?.category ?? null, categoryAfter: a?.category ?? null, left, right };
  });
  return { documentsAdded: docs.filter((d) => !before.some((i) => i.document === d)), documentsRemoved: docs.filter((d) => !after.some((i) => i.document === d) && !excludedAfter.some((i) => i.document === d)), documents, totals, removedFate, pairs };
}

// ---------- Evidence packets (issue grouping) ----------

export const EvidencePacketSchema = z.object({ id: z.string().min(1), issue: z.string(), items: z.array(z.string()), pairs: z.array(z.tuple([z.string(), z.string()])), inputTokens: z.number().nonnegative() });
export const PacketSetSchema = z.object({
  name: z.string(), source: z.string(), settings: z.record(z.string(), z.unknown()), packets: z.array(EvidencePacketSchema),
  uncovered: z.array(z.object({ a: z.string(), b: z.string(), reason: z.string() })), tokenAssumption: z.string(),
});
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;
export type PacketSet = z.infer<typeof PacketSetSchema>;

const spread = (xs: readonly number[]) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0] ?? 0, median: s.length ? s[Math.floor((s.length - 1) / 2)] : 0, max: s.at(-1) ?? 0, total: s.reduce((a, b) => a + b, 0) }; };

export type PacketPair = {
  id: string; kind: PairKind; category: string;
  together: string[]; // packets holding an item of each side
  listed: string[]; // packets naming a joining pair explicitly
  firstPacket: number | null; // 1-based position of the first `together` packet: packets read to reach it
  tokensToReach: number | null; // projected tokens through that packet
  uncovered: string[]; // the set's own uncovered entries joining this pair, with reasons
};
export type PacketReport = {
  name: string; source: string; settings: Record<string, unknown>; tokenAssumption: string;
  packets: number; calls: number; distinctItems: number;
  itemsPerPacket: ReturnType<typeof spread>; pairsPerPacket: ReturnType<typeof spread>;
  statedTokens: number; projectedTokens: number; pairByPairTokens: number; overhead: number;
  pairs: PacketPair[];
  together: Counted; listed: Counted; classes: Record<TargetClass, [held: number, of: number]>;
  uncovered: number; unlabelledListedPairs: number;
  problems: Problem[];
};

// Whether each labelled pair's two sides are put in front of the adjudicator together, and what the set costs:
// the set's stated inputTokens, an independent projection (distinct items per packet + overhead per call), and
// what adjudicating the same listed pairs one by one would take.
export function evaluatePackets(set: PacketSet, pairs: readonly FrozenPair[], items: ReadonlyMap<string, FrozenItem>, overhead = CALL_OVERHEAD_TOKENS): PacketReport {
  const join = pairs.map(joins);
  const problems: Problem[] = [];
  const ids = new Set<string>();
  const uniquePairs = new Set<string>();
  let pairByPairTokens = 0, unlabelledListed = 0, projectedTokens = 0;
  const projected: number[] = [];
  for (const p of set.packets) {
    if (ids.has(p.id)) problems.push({ check: "packets", detail: `packet id ${p.id} repeats` });
    ids.add(p.id);
    const own = new Set(p.items);
    const unknown = p.items.filter((k) => !items.has(k));
    if (unknown.length) problems.push({ check: "packets", detail: `${p.id}: ${unknown.length} item(s) not in the corpus, e.g. ${unknown[0]}` });
    let outside = 0, sameSession = 0;
    for (const [a, b] of p.pairs) {
      if (!own.has(a) || !own.has(b)) outside++;
      if (items.get(a) && items.get(a)!.session === items.get(b)?.session) sameSession++;
      if (!join.some((j) => j(a, b))) unlabelledListed++;
      const key = pairKey(a, b);
      if (!uniquePairs.has(key)) { uniquePairs.add(key); pairByPairTokens += itemTokens(items.get(a)) + itemTokens(items.get(b)) + overhead; }
    }
    if (outside) problems.push({ check: "packets", detail: `${p.id}: ${outside} listed pair(s) name an item the packet does not hold` });
    if (sameSession) problems.push({ check: "packets", detail: `${p.id}: ${sameSession} listed pair(s) join two items of one session` });
    projectedTokens += [...own].reduce((n, k) => n + itemTokens(items.get(k)), 0) + overhead;
    projected.push(projectedTokens);
  }
  const out: PacketPair[] = pairs.map((pair, i) => {
    const [L, R] = [new Set(pair.left), new Set(pair.right)];
    const together: string[] = [], listed: string[] = [];
    let first: number | null = null;
    set.packets.forEach((p, n) => {
      if (p.items.some((k) => L.has(k)) && p.items.some((k) => R.has(k))) { together.push(p.id); first ??= n; }
      if (p.pairs.some(([a, b]) => join[i](a, b))) listed.push(p.id);
    });
    const uncovered = set.uncovered.filter((u) => join[i](u.a, u.b)).map((u) => u.reason);
    return { id: pair.id, kind: kindOf(pair.category), category: pair.category, together, listed, firstPacket: first === null ? null : first + 1, tokensToReach: first === null ? null : projected[first], uncovered };
  });
  return {
    name: set.name, source: set.source, settings: set.settings, tokenAssumption: set.tokenAssumption,
    packets: set.packets.length, calls: set.packets.length, distinctItems: new Set(set.packets.flatMap((p) => p.items)).size,
    itemsPerPacket: spread(set.packets.map((p) => p.items.length)), pairsPerPacket: spread(set.packets.map((p) => p.pairs.length)),
    statedTokens: set.packets.reduce((n, p) => n + p.inputTokens, 0), projectedTokens, pairByPairTokens, overhead,
    pairs: out,
    together: countBy(out, (i) => out[i].together.length > 0), listed: countBy(out, (i) => out[i].listed.length > 0),
    classes: countClasses(out.map((p) => ({ category: p.category, held: p.together.length > 0 }))),
    uncovered: set.uncovered.length, unlabelledListedPairs: unlabelledListed, problems,
  };
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
