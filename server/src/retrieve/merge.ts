// Merges the retrieval paths' candidates into one ranked list (DESIGN.md, "Merging and ranking").
// Pure: no I/O.
//
// A candidate is a pair of logical exchanges. Its score is reciprocal rank fusion, the sum over the
// paths that found it of 1 / (RRF_K + rank), with the standard, untuned K = 60. Every path's own rank
// and exact evidence is kept side by side (Path B's part pair and shared terms, Path A's part pair,
// claims and signal), so nothing is collapsed to one guess and each path stays measurable on its own.

import type { ClaimPair, Signal } from "./pathA";
import type { LogicalExchange, RankedPair } from "./rank";

export const RRF_K = 60;
export const PER_EXCHANGE_CAP = 3; // DESIGN.md default, to be validated with labels
export const PAIR_BUDGET = 300; // DESIGN.md default for two sessions

export type Path = "claims" | "fulltext";

export type Evidence =
  | { path: "fulltext"; rank: number; exchangeA: number; exchangeB: number; score: number; sharedTerms: string[] }
  | { path: "claims"; rank: number; exchangeA: number; exchangeB: number; claimA: number; claimB: number; signal: Signal; predicate: string; sharedEntities: string[] };

export type Candidate = {
  rank: number;
  rrfScore: number;
  a: LogicalExchange;
  b: LogicalExchange;
  sources: Path[]; // which paths found it, claims first
  ranks: Partial<Record<Path, number>>;
  evidence: Evidence[]; // one entry per path that found it
};

const key = (a: LogicalExchange, b: LogicalExchange) => `${a.depositionId}:${a.groupId}|${b.depositionId}:${b.groupId}`;
const compareLogical = (x: LogicalExchange, y: LogicalExchange) => x.depositionId - y.depositionId || x.groupId - y.groupId;

export function mergeCandidates({ claims = [], fulltext = [] }: { claims?: readonly ClaimPair[]; fulltext?: readonly RankedPair[] }): Candidate[] {
  const merged = new Map<string, Omit<Candidate, "rank">>();
  const add = (a: LogicalExchange, b: LogicalExchange, evidence: Evidence) => {
    const k = key(a, b);
    const seen = merged.get(k) ?? { rrfScore: 0, a, b, sources: [], ranks: {}, evidence: [] };
    seen.rrfScore += 1 / (RRF_K + evidence.rank);
    seen.sources.push(evidence.path);
    seen.ranks[evidence.path] = evidence.rank;
    seen.evidence.push(evidence);
    merged.set(k, seen);
  };
  for (const p of claims) {
    add(p.a, p.b, { path: "claims", rank: p.rank, exchangeA: p.exchangeA, exchangeB: p.exchangeB, claimA: p.claimA, claimB: p.claimB, signal: p.signal, predicate: p.predicate, sharedEntities: p.sharedEntities });
  }
  for (const p of fulltext) {
    add(p.a, p.b, { path: "fulltext", rank: p.rank, exchangeA: p.exchangeA, exchangeB: p.exchangeB, score: p.score, sharedTerms: p.sharedTerms });
  }
  return [...merged.values()]
    .sort((x, y) => y.rrfScore - x.rrfScore || compareLogical(x.a, y.a) || compareLogical(x.b, y.b))
    .map((c, i) => ({ rank: i + 1, ...c }));
}

export type Deferred = Candidate & { reason: "cap" | "budget" };

// Takes candidates in rank order up to the pair budget, at most `perExchangeCap` per logical
// exchange, so one long answer can't fill the budget. Nothing is dropped: every other candidate is
// returned as deferred with its reason.
export function selectCandidates(
  candidates: readonly Candidate[],
  { budget = PAIR_BUDGET, perExchangeCap = PER_EXCHANGE_CAP }: { budget?: number; perExchangeCap?: number } = {},
): { selected: Candidate[]; deferred: Deferred[] } {
  const selected: Candidate[] = [];
  const deferred: Deferred[] = [];
  const uses = new Map<string, number>();
  const side = (x: LogicalExchange) => `${x.depositionId}:${x.groupId}`;
  for (const c of candidates) {
    if ((uses.get(side(c.a)) ?? 0) >= perExchangeCap || (uses.get(side(c.b)) ?? 0) >= perExchangeCap) {
      deferred.push({ ...c, reason: "cap" });
    } else if (selected.length >= budget) {
      deferred.push({ ...c, reason: "budget" });
    } else {
      selected.push(c);
      for (const s of [side(c.a), side(c.b)]) uses.set(s, (uses.get(s) ?? 0) + 1);
    }
  }
  return { selected, deferred };
}
