// The retrieval feasibility probe: can independent retrieval over original testimony bring the known
// review-worthy pairs (data/eval/evidence-fixtures-v1.json) into a practical candidate budget, across the
// whole indexed corpus? Four paths run with Stage 2 facts entirely absent; facts are then added as an
// optional fifth signal and measured separately. Nothing here calls a model.
//
// Corpus: every real fixture document, loaded together into one evaluation case (all of Hutchinson,
// Simpson and Resnick), so each pair must be found among every other session's testimony.

import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { buildUnits, compatibility, loadDocument, type Span } from "../claims/facts";
import { sourceHashOf } from "../claims/facts/context";
import type { Database } from "../db/client";
import { classifyGroups, type Eligibility } from "../evidence/eligibility";
import { depositions } from "../db/schema";
import { anchorNeighbours, anchors, denseNeighbours, nameVocabulary, fuse, lsa, pairRank, queryRank, rankPairs, sparseNeighbours, tfidf, tokens, type Item, type Neighbour, type Pair } from "../retrieve/independent";
import { COURTROOM_WORDS } from "../retrieve/procedural";
import type { EvidenceFixture, LoadedFixtures } from "./evidenceFixtures";

export const NEIGHBOURS_PER_ITEM = 100; // per path, before pairs are deduplicated and ranked across the case
export const BUDGETS = [20, 50, 100, 250, 1000] as const;
const FTS_TERMS = 12;

export type ProbeItem = Item & { document: string; documentId: number; groupId: number; positions: Set<string>; text: string; orderedPositions: string[]; sourceHash: string; eligibility: Eligibility };
export type FactSignal = { sha: string; position: string; factualDimension: string | null; factualQuestion: string | null; subject: string | null; entities: string[]; object: string | null; polarity: string | null };

const join = (spans: readonly Span[]) => spans.map((s) => s.text).join(" ");

// One item per logical answer group: its question, its answer and the lines before it, with its evidence
// class (evidence/eligibility.ts). Only eligible groups (which always hold testimony) are items, with ids
// contiguous as the paths need; every other group, including those with no answer at all, is returned in
// `excluded` with its class and reason, never dropped.
export async function loadItems(db: Database, l: LoadedFixtures): Promise<{ items: ProbeItem[]; excluded: ProbeItem[]; shaOf: Map<string, string> }> {
  const all: ProbeItem[] = [];
  const shaOf = new Map<string, string>();
  for (const [key, id] of l.docId) {
    const [d] = await db.select({ session: depositions.sessionId, sha: depositions.fileSha256 }).from(depositions).where(eq(depositions.id, id));
    shaOf.set(key, d.sha);
    const units = buildUnits(await loadDocument(db, id));
    const groups = [...new Set(units.map((u) => u.groupId))].map((g) => ({ g, parts: units.filter((u) => u.groupId === g) }));
    const spansOf = groups.map(({ parts }) => [...new Map(parts.flatMap((u) => u.spans).map((s) => [s.sourceSpanId, s])).values()]);
    const classes = classifyGroups(spansOf);
    groups.forEach(({ g, parts }, n) => {
      const spans = spansOf[n];
      const question = join(spans.filter((s) => s.speaker === "attorney"));
      const answer = join(spans.filter((s) => s.speaker === "witness" || s.speaker === "unknown"));
      const context = join(parts[0].context);
      const ordered = [...new Set(spans.map((s) => s.position))];
      all.push({ id: -1, session: d.session, question, answer, context, document: key, documentId: id, groupId: g, positions: new Set(ordered), orderedPositions: ordered, sourceHash: sourceHashOf(spans), text: `${question} ${answer}`, eligibility: classes[n] });
    });
  }
  const items = all.filter((i) => i.eligibility.eligible).map((i, n) => ({ ...i, id: n }));
  return { items, excluded: all.filter((i) => !i.eligibility.eligible), shaOf };
}

const position = (p: string) => { const [a, b] = p.split(":").map(Number); return a * 1e6 + b; };
export function itemsOf(items: readonly ProbeItem[], side: { document: string; from: string; to: string }): Set<number> {
  const [from, to] = [position(side.from), position(side.to)];
  return new Set(items.filter((i) => i.document === side.document && [...i.positions].some((p) => position(p) >= from && position(p) <= to)).map((i) => i.id));
}

// Path A: Postgres full-text search, as Path B does it, over the items: each item queries with its
// FTS_TERMS rarest content lexemes (OR), ranked by ts_rank_cd among other sessions' items.
export async function fullText(pool: Pool, items: readonly ProbeItem[], k: number, rows?: ReadonlySet<number>): Promise<Neighbour[][]> {
  const client = await pool.connect();
  try {
    await client.query("create temp table if not exists probe_items (id int primary key, session bigint, tsv tsvector)");
    await client.query("truncate probe_items");
    for (let i = 0; i < items.length; i += 500) {
      const batch = items.slice(i, i + 500);
      await client.query("insert into probe_items select x.id, x.session, to_tsvector('english', x.text) from jsonb_to_recordset($1::jsonb) as x(id int, session bigint, text text)", [JSON.stringify(batch.map((b) => ({ id: b.id, session: b.session, text: b.text })))]);
    }
    await client.query("create index if not exists probe_items_tsv on probe_items using gin (tsv)");
    const courtroom = (await client.query("select array(select unnest(tsvector_to_array(to_tsvector('english', $1)))) as t", [COURTROOM_WORDS.join(" ")])).rows[0].t as string[];
    const lexemes = (await client.query("select id, tsvector_to_array(tsv) as t from probe_items order by id")).rows as { id: number; t: string[] }[];
    const df = new Map<string, number>();
    for (const r of lexemes) for (const t of r.t) df.set(t, (df.get(t) ?? 0) + 1);
    const queries = lexemes.filter((r) => !rows || rows.has(r.id)).map((r) => ({ id: r.id, terms: r.t.filter((t) => !courtroom.includes(t) && (df.get(t) ?? 0) >= 2 && (df.get(t) ?? 0) <= items.length * 0.2).sort((a, b) => df.get(a)! - df.get(b)! || a.localeCompare(b)).slice(0, FTS_TERMS) })).filter((q) => q.terms.length > 0);
    const out: Neighbour[][] = items.map(() => []);
    for (let i = 0; i < queries.length; i += 200) {
      const res = await client.query(`
        with q as (select x.id, (select string_agg('''' || replace(t, '''', '''''') || '''', ' | ') from unnest(x.terms) t)::tsquery as tsq from jsonb_to_recordset($1::jsonb) as x(id int, terms text[]))
        select q.id as source, m.id as target, m.rank from q
        cross join lateral (select p.id, ts_rank_cd(p.tsv, q.tsq, 1) as rank from probe_items p, probe_items s where s.id = q.id and p.session <> s.session and p.tsv @@ q.tsq order by rank desc, p.id limit $2) m`, [JSON.stringify(queries.slice(i, i + 200)), k]);
      for (const r of res.rows as { source: number; target: number; rank: number }[]) out[r.source].push({ id: r.target, score: r.rank });
    }
    return out;
  } finally {
    client.release();
  }
}

// Path E (optional): Stage 2 facts, where they exist, compared with compatibility(). Facts only exist where
// a pilot extracted them, so this can only add pairs among those items.
function factNeighbours(items: readonly ProbeItem[], factsByItem: Map<number, FactSignal[]>, k: number): Neighbour[][] {
  const withFacts = [...factsByItem.keys()];
  return items.map((it) => {
    const mine = factsByItem.get(it.id);
    if (!mine) return [];
    const acc = new Map<number, number>();
    for (const other of withFacts) {
      if (items[other].session === it.session) continue;
      for (const a of mine) for (const b of factsByItem.get(other)!) {
        const c = compatibility(a, b);
        const score = c.questionOverlap + (c.sameKey ? 0.5 : 0) + 0.5 * c.entityOverlap;
        if (c.compatible && score > (acc.get(other) ?? 0)) acc.set(other, score);
      }
    }
    return [...acc].sort((x, y) => y[1] - x[1]).slice(0, k).map(([id, score]) => ({ id, score }));
  });
}

export async function runRetrievalProbe(db: Database, pool: Pool, l: LoadedFixtures, f: EvidenceFixture, facts: FactSignal[] = []) {
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, step: () => Promise<T> | T): Promise<T> => { const t0 = performance.now(); const r = await step(); timings[name] = Math.round(performance.now() - t0); return r; };
  const { items, shaOf } = await time("load", () => loadItems(db, l));
  const pairs = f.items.map((x) => ({ id: x.id, category: x.category, controlType: x.controlType, left: itemsOf(items, x.sides[0]), right: itemsOf(items, x.sides[1]) }));
  const sideItems = new Set(pairs.flatMap((p) => [...p.left, ...p.right]));
  const n = items.length;

  // Each path: neighbours for every item (top NEIGHBOURS_PER_ITEM), and full rankings for the pairs' items.
  const docTokens = items.map((i) => tokens(`${i.question} ${i.answer} ${i.context.split(/\s+/).slice(-60).join(" ")}`));
  const questionTokens = items.map((i) => tokens(`${i.question} ${i.context.split(/\s+/).slice(-60).join(" ")}`));
  const names = nameVocabulary(items.map((i) => `${i.text} ${i.context}`));
  const own = items.map((i) => anchors(i.text, names));
  const ctx = items.map((i) => anchors(i.context, names));
  const paths: Record<string, { neighbours: Neighbour[][]; full: Neighbour[][] }> = {};
  paths.A_fulltext = await time("A_fulltext", async () => ({ neighbours: await fullText(pool, items, NEIGHBOURS_PER_ITEM), full: await fullText(pool, items, n, sideItems) }));
  paths.B_semantic_lsa = await time("B_semantic_lsa", () => {
    const t = tfidf(docTokens, { maxDfShare: 0.5 });
    const dense = lsa(t.vectors, t.vocabulary.length);
    return { neighbours: denseNeighbours(items, dense, NEIGHBOURS_PER_ITEM), full: denseNeighbours(items, dense, n, () => true, sideItems) };
  });
  paths.C_question = await time("C_question", () => {
    const t = tfidf(questionTokens);
    return { neighbours: sparseNeighbours(items, t.vectors, NEIGHBOURS_PER_ITEM), full: sparseNeighbours(items, t.vectors, n, () => true, sideItems) };
  });
  paths.D_anchors = await time("D_anchors", () => ({ neighbours: anchorNeighbours(items, own, ctx, NEIGHBOURS_PER_ITEM), full: anchorNeighbours(items, own, ctx, n, () => true, sideItems) }));

  const factsByItem = new Map<number, FactSignal[]>();
  for (const fact of facts) {
    const doc = [...shaOf].find(([, sha]) => sha === fact.sha)?.[0];
    const item = items.find((i) => i.document === doc && i.positions.has(fact.position));
    if (item) factsByItem.set(item.id, [...(factsByItem.get(item.id) ?? []), fact]);
  }
  if (factsByItem.size) paths.E_facts = await time("E_facts", () => { const nb = factNeighbours(items, factsByItem, NEIGHBOURS_PER_ITEM); return { neighbours: nb, full: nb }; });

  const ranked: Record<string, Pair[]> = Object.fromEntries(Object.entries(paths).map(([name, p]) => [name, rankPairs(p.neighbours)]));
  const independent = ["A_fulltext", "B_semantic_lsa", "C_question", "D_anchors"];
  ranked.fused_ABCD = fuse(independent.map((p) => ranked[p]));
  for (const p of independent) ranked[`fused_without_${p}`] = fuse(independent.filter((x) => x !== p).map((x) => ranked[x]));
  if (paths.E_facts) ranked.fused_ABCD_plus_facts = fuse([...independent, "E_facts"].map((p) => ranked[p]));

  const report = Object.entries(ranked).map(([name, list]) => {
    const path = paths[name];
    const results = pairs.map((p) => {
      const global = pairRank(list, p.left, p.right);
      const query = path ? Math.min(...[...p.left].map((i) => queryRank(path.full[i], p.right) ?? Infinity), ...[...p.right].map((i) => queryRank(path.full[i], p.left) ?? Infinity)) : null;
      return { pair: p.id, category: p.category, globalRank: global, queryRank: query === null || query === Infinity ? null : query };
    });
    const worthy = results.filter((r) => r.category === "review_worthy");
    const recallAt = (k: number, rs: typeof results) => rs.filter((r) => r.globalRank !== null && r.globalRank <= k).length;
    return {
      path: name, candidates: list.length,
      recall: Object.fromEntries(BUDGETS.map((k) => [`@${k}`, { reviewWorthy: `${recallAt(k, worthy)}/${worthy.length}`, all: `${recallAt(k, results)}/${results.length}` }])),
      excludedAt100: results.filter((r) => r.globalRank === null || r.globalRank > 100).map((r) => r.pair),
      pairs: results,
    };
  });
  // Per-item budgets: every item keeps its k best neighbours. A pair is recovered at k when either side
  // finds the other within its k best; the cost is the number of distinct pairs all items' top k make.
  const K_PER_ITEM = [1, 3, 5, 10, 25, 50] as const;
  const independentPaths = independent.map((name) => paths[name]);
  const pairCount = (lists: Neighbour[][][], k: number) => { const keys = new Set<string>(); for (const nb of lists) nb.forEach((ns, a) => { for (const { id: b } of ns.slice(0, k)) keys.add(a < b ? `${a}:${b}` : `${b}:${a}`); }); return keys.size; };
  const bestQueryRank = (path: { full: Neighbour[][] }, p: (typeof pairs)[number]) => Math.min(...[...p.left].map((i) => queryRank(path.full[i], p.right) ?? Infinity), ...[...p.right].map((i) => queryRank(path.full[i], p.left) ?? Infinity));
  // Per-query fusion: an item's paths' rankings fused by reciprocal rank, so each query keeps one list.
  const fusedFull = new Map<number, Neighbour[]>();
  for (const i of sideItems) {
    const score = new Map<number, number>();
    for (const path of independentPaths) path.full[i].forEach((x, r) => score.set(x.id, (score.get(x.id) ?? 0) + 1 / (60 + r + 1)));
    fusedFull.set(i, [...score].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([id, sc]) => ({ id, score: sc })));
  }
  const fusedPath = { full: items.map((_, i) => fusedFull.get(i) ?? []) };
  const perItem = K_PER_ITEM.map((k) => {
    const byPath = Object.fromEntries([...independent, ...(paths.E_facts ? ["E_facts"] : [])].map((name) => [name, { recovered: pairs.filter((p) => p.category === "review_worthy" && bestQueryRank(paths[name], p) <= k).map((p) => p.id), candidatePairs: pairCount([paths[name].neighbours], k) }]));
    const union = pairs.filter((p) => p.category === "review_worthy" && independent.some((name) => bestQueryRank(paths[name], p) <= k)).map((p) => p.id);
    const fusedRecovered = pairs.filter((p) => p.category === "review_worthy" && bestQueryRank(fusedPath, p) <= k).map((p) => p.id);
    return { k, byPath, unionOfPaths: { recovered: union, candidatePairs: pairCount(independentPaths.map((x) => x.neighbours), k) }, fusedPerQuery: { recovered: fusedRecovered }, controlsRecoveredByUnion: pairs.filter((p) => p.category !== "review_worthy" && independent.some((name) => bestQueryRank(paths[name], p) <= k)).map((p) => p.id) };
  });
  // The budget a fused per-query list implies for every item, from each path's top NEIGHBOURS_PER_ITEM
  // (a path's item beyond that contributes nothing): distinct pairs when each item keeps its fused top k.
  const fusedTop = items.map((_, i) => {
    const score = new Map<number, number>();
    for (const path of independentPaths) path.neighbours[i].forEach((x, r) => score.set(x.id, (score.get(x.id) ?? 0) + 1 / (60 + r + 1)));
    return [...score].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([id, sc]) => ({ id, score: sc }));
  });
  const fusedBudgets = K_PER_ITEM.map((k) => ({ k, candidatePairs: pairCount([fusedTop], k), recovered: pairs.filter((p) => p.category === "review_worthy" && bestQueryRank({ full: fusedTop }, p) <= k).map((p) => p.id), controls: pairs.filter((p) => p.category !== "review_worthy" && bestQueryRank({ full: fusedTop }, p) <= k).map((p) => p.id) }));
  const fusedQueryRanks = pairs.map((p) => ({ pair: p.id, category: p.category, fusedQueryRank: Number.isFinite(bestQueryRank(fusedPath, p)) ? bestQueryRank(fusedPath, p) : null }));
  return {
    perItemBudgets: perItem,
    fusedBudgets,
    fusedQueryRanks,
    corpus: { documents: l.docId.size, items: n, sessions: new Set(items.map((i) => i.session)).size, pairSides: pairs.map((p) => ({ pair: p.id, left: p.left.size, right: p.right.size })), itemsWithFacts: factsByItem.size },
    settings: { neighboursPerItem: NEIGHBOURS_PER_ITEM, ftsTerms: FTS_TERMS, lsaDims: 150, fusion: "reciprocal rank, k = 60" },
    timingsMs: timings,
    paths: report,
  };
}

// Stage 2 facts of the dev database's pilot runs, located by file and line, for path E.
export async function pilotFacts(db: Database, extractorVersions: string[]): Promise<FactSignal[]> {
  const rows = await db.execute<FactSignal & { sha: string; position: string }>(sql`
    select d.file_sha256 as sha, l.printed_page || ':' || l.line_no as position, f.factual_dimension as "factualDimension", f.factual_question as "factualQuestion", f.subject, f.entities, f.object, f.polarity
    from facts f join depositions d on d.id = f.deposition_id join lines l on l.id = any(f.line_ids)
    where f.status = 'indexed' and f.extractor_version in (${sql.join(extractorVersions.map((v) => sql`${v}`), sql`, `)})`);
  return rows.rows;
}
