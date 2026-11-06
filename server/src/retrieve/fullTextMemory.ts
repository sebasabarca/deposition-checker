// Path A (Postgres full text) computed in memory, for large cases: the same neighbours as eval/retrievalProbe.ts
// fullText, which ranks every matching item inside Postgres (about 1 ms per query, matches growing with the case, so
// the path grows ~items^2.2). Postgres still parses every item (to_tsvector('english'), so lexemes and positions are
// its own); the queries and the ranking run here over an inverted index.
//
// For fullText's queries (each item's FTS_TERMS rarest lexemes, OR'ed), ts_rank_cd(tsv, query, 1) reduces to: every
// position of a query lexeme in the item is one cover of weight 0.1 (the D weight, as float4), summed, divided by
// ln(1 + the item's position count), cast to float4; Postgres prints that float4 in its shortest form, which pg parses.
// tests/db/fullTextMemory.test.ts and experiments/first-analysis/scale/checkA.ts check the lists
// against fullText's itself, byte for byte.

import type { Pool } from "pg";
import type { ProbeItem } from "../eval/retrievalProbe";
import { TopK, type Neighbour } from "./independent";
import { COURTROOM_WORDS } from "./procedural";

const FTS_TERMS = 12; // as eval/retrievalProbe.ts
// A one-position cover's weight, as calc_rank_cd computes it: (end - begin + 1) / (1 / w) with w the D weight 0.1 as a
// float4, divided by 1 + noise (0 for one position).
const COVER = 1 / (1 / Math.fround(0.1));

// The double pg hands back for a float4 column: Postgres prints the shortest decimal that reads back as the same float4.
export function float4AsPrinted(x: number): number {
  const f = Math.fround(x);
  for (let p = 1; p <= 9; p++) { const s = Number(f.toPrecision(p)); if (Math.fround(s) === f) return s; }
  return f;
}

// ts_rank_cd(tsv, an OR of lexemes, normalization 1) of an item with `covers` query positions and `length` positions.
export function orRankCd(covers: number, length: number): number {
  let w = 0;
  for (let i = 0; i < covers; i++) w += COVER; // summed one cover at a time, as Postgres does
  return float4AsPrinted(length > 0 ? w / Math.log(length + 1) : w);
}

type Lexeme = { lexeme: string; positions: number };

export async function fullTextMemory(pool: Pool, items: readonly ProbeItem[], k: number): Promise<Neighbour[][]> {
  const lexemesOf: Lexeme[][] = items.map(() => []);
  const client = await pool.connect();
  let courtroom: Set<string>;
  try {
    for (let i = 0; i < items.length; i += 500) {
      const batch = items.slice(i, i + 500);
      const res = await client.query("select x.id, u.lexeme, coalesce(array_length(u.positions, 1), 1) as n from jsonb_to_recordset($1::jsonb) as x(id int, text text), unnest(to_tsvector('english', x.text)) as u", [JSON.stringify(batch.map((b) => ({ id: b.id, text: b.text })))]);
      for (const r of res.rows as { id: number; lexeme: string; n: number }[]) lexemesOf[r.id].push({ lexeme: r.lexeme, positions: r.n });
    }
    courtroom = new Set((await client.query("select array(select unnest(tsvector_to_array(to_tsvector('english', $1)))) as t", [COURTROOM_WORDS.join(" ")])).rows[0].t as string[]);
  } finally {
    client.release();
  }
  const df = new Map<string, number>();
  const postings = new Map<string, [id: number, positions: number][]>();
  lexemesOf.forEach((ls, id) => { for (const l of ls) { df.set(l.lexeme, (df.get(l.lexeme) ?? 0) + 1); (postings.get(l.lexeme) ?? postings.set(l.lexeme, []).get(l.lexeme)!).push([id, l.positions]); } });
  const length = lexemesOf.map((ls) => ls.reduce((s, l) => s + l.positions, 0));
  const covers = new Uint32Array(items.length);
  const rankMemo = new Map<number, number>(); // by (covers, length): few distinct pairs
  const rank = (c: number, l: number) => { const key = c * 2 ** 26 + l; let r = rankMemo.get(key); if (r === undefined) rankMemo.set(key, (r = orRankCd(c, l))); return r; };
  return items.map((q) => {
    const terms = lexemesOf[q.id].map((l) => l.lexeme).filter((t) => !courtroom.has(t) && df.get(t)! >= 2 && df.get(t)! <= items.length * 0.2).sort((a, b) => df.get(a)! - df.get(b)! || a.localeCompare(b)).slice(0, FTS_TERMS);
    const touched: number[] = [];
    for (const t of terms) for (const [id, n] of postings.get(t)!) if (items[id].session !== q.session) { if (!covers[id]) touched.push(id); covers[id] += n; }
    const top = new TopK(k);
    // TopK breaks ties by id, as fullText's "order by rank desc, p.id" does.
    for (const id of touched) { top.offer(id, rank(covers[id], length[id])); covers[id] = 0; }
    return top.sorted();
  });
}
