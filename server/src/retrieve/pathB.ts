// Path B: candidate pairs from the original testimony, by full-text search (DESIGN.md,
// "Candidate retrieval"). It reads only exchanges, so it works without any claims.
//
// Three steps, each with one job:
// 1. Discovery (Postgres): each exchange part of the witness becomes a query against the other side
//    (the new deposition against the witness's other sessions, and they against it), keeping the
//    top MATCHES_PER_QUERY logical exchanges by ts_rank_cd among the eligible ones: those sharing
//    at least MIN_SHARED_TERMS weighted content terms with the querying part, the same rule that
//    makes a final score above 0. Filtering before the cut means a match that would score 0 can
//    never take a slot from one that wouldn't. ts_rank_cd only orders candidates; its scores aren't
//    comparable between queries with different terms, so they aren't kept.
// 2. Scoring (score.ts): one symmetric score per part pair, from the two exchanges' own terms.
// 3. Deduplication and ranking (rank.ts): one candidate per pair of logical exchanges.

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { depositions, exchanges } from "../db/schema";
import { COURTROOM_WORDS, MIN_CONTENT_TERMS, proceduralReason } from "./procedural";
import { queryTerms, type PathBQueryMode } from "./query";
import { rankPairs, type Match, type PartInfo, type RankedPair } from "./rank";
import { MIN_SHARED_TERMS, type TermFrequency } from "./score";

export const MATCHES_PER_QUERY = 5;

export type PathBResult = {
  pairs: RankedPair[];
  // Nothing is dropped silently: every exchange part of the witness is counted in exactly one of
  // procedural, tooFewTerms and queried.
  counts: {
    exchanges: number; // exchange parts of the witness's ready depositions
    procedural: number; // not testimony, or name and address
    tooFewTerms: number; // too few content terms to query (see procedural.ts)
    queried: number;
  };
};

// A stemmed term as a quoted tsquery operand. Quoting keeps characters such as ':' or '!' from
// being read as tsquery syntax; inside quotes, a quote is doubled and a backslash escaped.
const quotedTerm = (term: ReturnType<typeof sql>) =>
  sql`'''' || replace(replace(${term}, '\\', '\\\\'), '''', '''''') || ''''`;

// The exchange's distinct stemmed terms, minus the courtroom words, stemmed the same way.
const contentTerms = sql`array(
  select t from unnest(tsvector_to_array(${exchanges.tsv})) t
  where t <> all(tsvector_to_array(to_tsvector('english', ${COURTROOM_WORDS.join(" ")})))
  order by t
)`;

// How many logical exchanges of the case's ready depositions use each term, and how many there are.
async function termFrequency(db: Database, caseId: number): Promise<TermFrequency> {
  const [terms, total] = await Promise.all([
    db.execute<{ term: string; n: number }>(sql`
      select t as term, count(distinct (e.deposition_id, e.group_id))::int as n
      from ${exchanges} e
      join ${depositions} d on d.id = e.deposition_id,
      unnest(tsvector_to_array(e.tsv)) t
      where d.case_id = ${caseId} and d.status = 'ready'
      group by t
    `),
    db.execute<{ n: number }>(sql`
      select count(distinct (e.deposition_id, e.group_id))::int as n
      from ${exchanges} e
      join ${depositions} d on d.id = e.deposition_id
      where d.case_id = ${caseId} and d.status = 'ready'
    `),
  ]);
  return { exchanges: total.rows[0].n, frequency: new Map(terms.rows.map((r) => [r.term, r.n])) };
}

export async function findPathB(
  db: Database,
  { witnessId, depositionId, mode }: { witnessId: number; depositionId: number; mode: PathBQueryMode },
): Promise<PathBResult> {
  // Every exchange part of the witness's ready depositions, with its content terms.
  const rows = await db
    .select({
      id: exchanges.id,
      depositionId: exchanges.depositionId,
      groupId: exchanges.groupId,
      kind: exchanges.kind,
      questionText: exchanges.questionText,
      terms: sql<string[]>`${contentTerms}`,
      caseId: depositions.caseId,
    })
    .from(exchanges)
    .innerJoin(depositions, eq(depositions.id, exchanges.depositionId))
    .where(and(eq(exchanges.witnessId, witnessId), eq(depositions.status, "ready")));

  // Testimony can be found by any query; only parts with at least MIN_CONTENT_TERMS run queries of
  // their own (see procedural.ts for why two-term parts don't).
  const canQuery = (terms: readonly string[]) => terms.length >= MIN_CONTENT_TERMS;
  const counts = { exchanges: rows.length, procedural: 0, tooFewTerms: 0, queried: 0 };
  const parts = new Map<number, PartInfo>();
  const queryParts: PartInfo[] = [];
  for (const r of rows) {
    if (proceduralReason(r) !== null) {
      counts.procedural++;
      continue;
    }
    const part = { id: r.id, depositionId: r.depositionId, groupId: r.groupId, terms: r.terms };
    parts.set(r.id, part);
    if (canQuery(r.terms)) queryParts.push(part);
    else counts.tooFewTerms++;
  }
  counts.queried = queryParts.length;
  if (queryParts.length === 0) return { pairs: [], counts };

  const weights = await termFrequency(db, rows[0].caseId);
  const queries = queryParts.map((p) => ({
    id: p.id,
    deposition_id: p.depositionId,
    terms: queryTerms(p.terms, mode, weights), // what the query searches for
    content: p.terms, // what eligibility and the final score compare
  }));
  const searchable = sql`${`{${[...parts.keys()].join(",")}}`}::bigint[]`;
  // Terms every logical exchange of the case uses weigh 0 (score.ts), so they don't count as shared.
  const weightless = [...weights.frequency].filter(([, df]) => df >= weights.exchanges).map(([term]) => term);

  // Each query's top eligible matches, at most one part per logical exchange so a split answer can't
  // take several of the slots. Targets are testimony parts on the other side of the new deposition.
  // The query part's content terms exclude the courtroom words, so the shared ones do too.
  const result = await db.execute<{ source: string; target: string }>(sql`
    with query as (
      select q.id, q.deposition_id, q.content,
        (select string_agg(${quotedTerm(sql`t`)}, ' | ') from unnest(q.terms) t)::tsquery as tsq
      from jsonb_to_recordset(${JSON.stringify(queries)}::jsonb) as q(id bigint, deposition_id bigint, terms text[], content text[])
    )
    select q.id as source, m.id as target
    from query q
    cross join lateral (
      select id from (
        select distinct on (t.deposition_id, t.group_id) t.id, ts_rank_cd(t.tsv, q.tsq, 1) as relevance
        from exchanges t
        where t.id = any(${searchable})
          and t.deposition_id <> q.deposition_id
          and ${depositionId} in (q.deposition_id, t.deposition_id)
          and t.tsv @@ q.tsq
          and (
            select count(*) from unnest(q.content) c
            where c = any(tsvector_to_array(t.tsv)) and c <> all(${`{${weightless.map((t) => JSON.stringify(t)).join(",")}}`}::text[])
          ) >= ${MIN_SHARED_TERMS}
        order by t.deposition_id, t.group_id, relevance desc, t.id
      ) best
      order by relevance desc, id
      limit ${MATCHES_PER_QUERY}
    ) m
  `);

  const matches: Match[] = result.rows.map((r) => ({ source: Number(r.source), target: Number(r.target) }));
  return { pairs: rankPairs(matches, parts, weights), counts };
}
