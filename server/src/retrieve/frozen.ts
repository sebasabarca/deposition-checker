// The frozen retrieval benchmark format: what a retrieval experiment reads and writes, so experiments,
// candidate triage and evaluation can run separately, without a database, on exactly the same corpus.
// Pure apart from the JSON helpers at the end. Item keys are stable across loads of the same files:
// the document's fixture key and the answer group's first and last stored positions.
//
//   items.json        FrozenItem[]: every eligible answer group, with its own words, context and evidence class
//   excluded-items.json  FrozenItem[]: every ineligible answer group, with its class and reason (never dropped)
//   errata.json       FrozenItem[]: the excluded groups classed errata_or_correction, kept for review
//   benchmark.json    FrozenBenchmark: the labelled pairs, each side resolved to item keys
//   rankings.json     PathRankings[]: each path's full ranking from every labelled side's items
//   pool-<name>.json  CandidatePool: candidate pairs, each with every path's rank in both directions
//   manifest.json     settings, counts and SHA-256 of every file

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export type FrozenItem = {
  key: string; // `${document}#${first}-${last}`
  document: string; // fixture key
  witness: string;
  session: string; // fixture session name: files of one sitting share it
  groupId: number;
  positions: string[]; // "page:line" of every source line, as stored
  sourceHash: string; // of the group's spans (Stage 2 context.ts sourceHashOf), to key caches
  question: string; // attorney spans
  answer: string; // witness and unidentified-speaker spans
  context: string; // the group before it, as the extraction context shows it
  eligibility?: { class: string; eligible: boolean; reason: string }; // evidence/eligibility.ts; absent in corpora frozen before it
};

export type FrozenPair = { id: string; category: string; controlType?: string; source: string; left: string[]; right: string[] };
export type FrozenBenchmark = { corpus: string; pairs: FrozenPair[] };

export type Ranked = [key: string, score: number];
// A path's full ranking (other sessions only) from each item of the labelled sides.
export type PathRankings = { path: string; rankings: Record<string, Ranked[]> };
// A path's best neighbours for every item, to depth `depth`: what fusion and pools are built from.
export type PathNeighbours = { path: string; depth: number; neighbours: Record<string, Ranked[]> };

// One candidate pair: keys in sorted order, the fused score, and each path's rank of b from a and of a
// from b (1-based, null when beyond the path's depth or absent).
export type Candidate = { a: string; b: string; fused: number; ranks: Record<string, [ab: number | null, ba: number | null]> };
export type CandidatePool = { name: string; perItem: number; paths: string[]; candidates: Candidate[] };

export const itemKeyOf = (document: string, positions: readonly string[]) => `${document}#${positions[0]}-${positions[positions.length - 1]}`;
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Reciprocal-rank fusion of several paths' rankings from one query: score = sum of 1 / (k + rank).
export function fuseRankings(lists: readonly (readonly Ranked[])[], k = 60): Ranked[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach(([key], r) => score.set(key, (score.get(key) ?? 0) + 1 / (k + r + 1)));
  return [...score].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
}

// Diversified selection (optional; absent = the plain fused top `perItem`, unchanged). Each item keeps its fused top
// `perItem`, plus, from the same fused ranking, its best `perGroup` not yet chosen in every counterpart group
// (`groupOf`: e.g. another session or witness), plus each path's own best `perPath` not yet chosen. Bounded: at most
// perItem + groups x perGroup + paths x perPath partners per item, never all-to-all.
// minShare: a quota partner is admitted only when its fused score is at least minShare x the score of the item's
// perItem-th fused partner, so a session with nothing relevant adds nothing (bounded by relevance, not by session count).
export type PoolSelection = { quota?: { groupOf: (key: string) => string; perGroup: number; minShare?: number }; perPath?: number };

// The pool every item's fused top `perItem` makes, each pair once, with every path's ranks attached.
export function buildPool(name: string, paths: readonly PathNeighbours[], perItem: number, selection: PoolSelection = {}): CandidatePool {
  const rankOf = paths.map((p) => new Map(Object.entries(p.neighbours).map(([q, list]) => [q, new Map(list.map(([key], r) => [key, r + 1]))])));
  const keys = new Set(paths.flatMap((p) => Object.keys(p.neighbours)));
  const candidates = new Map<string, Candidate>();
  for (const q of keys) {
    const fused = fuseRankings(paths.map((p) => p.neighbours[q] ?? []));
    const chosen = selectPartners(q, fused, paths, perItem, selection);
    for (const [other, score] of chosen) {
      const id = pairKey(q, other);
      const [a, b] = q < other ? [q, other] : [other, q];
      const existing = candidates.get(id);
      if (existing) { existing.fused = Math.max(existing.fused, score); continue; }
      candidates.set(id, { a, b, fused: score, ranks: Object.fromEntries(paths.map((p, i) => [p.path, [rankOf[i].get(a)?.get(b) ?? null, rankOf[i].get(b)?.get(a) ?? null]])) });
    }
  }
  return { name, perItem, paths: paths.map((p) => p.path), candidates: [...candidates.values()].sort((x, y) => y.fused - x.fused || (x.a + x.b < y.a + y.b ? -1 : 1)) };
}

function selectPartners(q: string, fused: readonly Ranked[], paths: readonly PathNeighbours[], perItem: number, { quota, perPath = 0 }: PoolSelection): Ranked[] {
  const out = fused.slice(0, perItem);
  if (!quota && !perPath) return out;
  const taken = new Set(out.map(([k]) => k));
  const scoreOf = new Map(fused);
  if (quota && quota.perGroup > 0) {
    const counts = new Map<string, number>();
    const floor = (quota.minShare ?? 0) * (out.at(-1)?.[1] ?? 0);
    for (const [k, sc] of fused) {
      if (sc < floor) break; // fused is sorted by score
      if (taken.has(k)) continue;
      const g = quota.groupOf(k);
      if ((counts.get(g) ?? 0) >= quota.perGroup) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
      taken.add(k);
      out.push([k, sc]);
    }
  }
  for (const p of perPath ? paths : []) {
    let n = 0;
    for (const [k] of p.neighbours[q] ?? []) {
      if (n >= perPath) break;
      if (taken.has(k)) continue;
      taken.add(k);
      n++;
      out.push([k, scoreOf.get(k) ?? 0]);
    }
  }
  return out;
}

// The 1-based rank of the first of `targets` in a ranking, or null.
export const rankIn = (list: readonly Ranked[], targets: ReadonlySet<string>) => { const i = list.findIndex(([k]) => targets.has(k)); return i < 0 ? null : i + 1; };

// Whether a pool holds a pair joining the two sides.
export const poolHolds = (pool: CandidatePool, left: ReadonlySet<string>, right: ReadonlySet<string>) => pool.candidates.some((c) => (left.has(c.a) && right.has(c.b)) || (left.has(c.b) && right.has(c.a)));

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
export const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
