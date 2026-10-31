// One candidate pool from both paths (DESIGN.md, "Candidate pool and selection"). Pure: no I/O.
//
// A pair found by both paths is one candidate. There is no fusion: each path keeps its own ranking,
// and selection takes turns between them in proportion to their shares, so the pool stays near 60/40
// at every point, not only at the end. That is why adjudication runs in selection order: when a
// budget stops it early, Path A can't have spent it before Path B contributed. A path with nothing
// left simply stops taking turns, which hands its capacity to the other. A pair both paths found uses
// one slot, is assessed once, and still counts toward both paths' coverage.

import type { RankedPair, LogicalExchange } from "./rank";
import { PATH_A_RANKING_VERSION, type CardSignal, type TopicPair } from "./topicPairs";

export const PATH_A_SHARE = 0.6;
// Higher than the pair pool's 3: Path A's pairs cluster on fewer exchanges, and at 3 the cap kept it
// well short of its share on Ellison (143 of 180 slots).
export const HYBRID_PER_EXCHANGE_CAP = 5;

// One reproducible retrieval and ranking configuration: a change to any part is a new version.
export const hybridRetrievalVersion = ({ extractorVersion, pathBMode, pathAShare = PATH_A_SHARE, perExchangeCap = HYBRID_PER_EXCHANGE_CAP }: { extractorVersion: string; pathBMode: string; pathAShare?: number; perExchangeCap?: number }) =>
  `hybrid-v1|${PATH_A_RANKING_VERSION}|${extractorVersion}|b:${pathBMode}|a:${pathAShare}|cap:${perExchangeCap}`;

export type Evidence =
  | { path: "fulltext"; rank: number; exchangeA: number; exchangeB: number; score: number; sharedTerms: string[] }
  | { path: "topics"; rank: number; exchangeA: number; exchangeB: number; cardA: number; cardB: number; signal: CardSignal; comparable: boolean; topicIds: number[]; sharedEntities: string[]; eventOverlap: number; cardPairs: number };

export type PoolCandidate = {
  rank: number; // the order adjudication takes them in; selected candidates come first
  a: LogicalExchange;
  b: LogicalExchange;
  sources: ("topics" | "fulltext")[];
  ranks: { topics?: number; fulltext?: number };
  evidence: Evidence[];
  topicIds: number[];
  status: "selected" | "deferred" | "excluded";
  selectedBy: "path_a" | "path_b" | null;
  deferredReason: string | null; // cap, budget, or the card label that put it last
  exclusionReason: string | null;
};

export type Pool = {
  candidates: PoolCandidate[]; // every input pair, once
  counts: {
    selected: number;
    deferred: number;
    excluded: number;
    pathA: number; // found by Path A only
    pathB: number;
    both: number;
    selectedBy: { path_a: number; path_b: number };
    targets: { path_a: number; path_b: number };
    redistributed: number; // slots taken beyond a path's share because the other ran out
  };
};

const keyOf = (a: LogicalExchange, b: LogicalExchange) => `${a.depositionId}:${a.groupId}|${b.depositionId}:${b.groupId}`;
const sideKey = (x: LogicalExchange) => `${x.depositionId}:${x.groupId}`;

export function unionCandidates(
  { topics = [], fulltext = [] }: { topics?: readonly TopicPair[]; fulltext?: readonly RankedPair[] },
  { capacity, pathAShare = PATH_A_SHARE, perExchangeCap = HYBRID_PER_EXCHANGE_CAP }: { capacity: number; pathAShare?: number; perExchangeCap?: number },
): Pool {
  if (!(pathAShare > 0 && pathAShare < 1)) throw new Error("Path A's share must be between 0 and 1.");
  const byPair = new Map<string, PoolCandidate>();
  for (const p of topics) {
    byPair.set(keyOf(p.a, p.b), {
      rank: 0, a: p.a, b: p.b, sources: ["topics"], ranks: { topics: p.rank }, topicIds: p.topicIds, status: "deferred", selectedBy: null, deferredReason: null, exclusionReason: p.exclusion,
      evidence: [{ path: "topics", rank: p.rank, exchangeA: p.exchangeA, exchangeB: p.exchangeB, cardA: p.cardA, cardB: p.cardB, signal: p.signal, comparable: p.comparable, topicIds: p.topicIds, sharedEntities: p.sharedEntities, eventOverlap: p.eventOverlap, cardPairs: p.cardPairs }],
    });
  }
  for (const p of fulltext) {
    const k = keyOf(p.a, p.b);
    const evidence: Evidence = { path: "fulltext", rank: p.rank, exchangeA: p.exchangeA, exchangeB: p.exchangeB, score: p.score, sharedTerms: p.sharedTerms };
    const seen = byPair.get(k);
    if (seen) {
      seen.sources.push("fulltext");
      seen.ranks.fulltext = p.rank;
      seen.evidence.push(evidence);
      seen.exclusionReason = null; // Path B read the testimony itself: Path A's cards don't lower it
    } else {
      byPair.set(k, { rank: 0, a: p.a, b: p.b, sources: ["fulltext"], ranks: { fulltext: p.rank }, topicIds: [], status: "deferred", selectedBy: null, deferredReason: null, exclusionReason: null, evidence: [evidence] });
    }
  }

  const all = [...byPair.values()];
  // exclusionReason here is a card label, the model's reading, and that never rules testimony out:
  // such a pair stays eligible, last in Path A's order, and defers with its reason if capacity runs out.
  const eligible = all;
  const lists = {
    path_a: eligible.filter((c) => c.ranks.topics !== undefined).sort((x, y) => x.ranks.topics! - y.ranks.topics!),
    path_b: eligible.filter((c) => c.ranks.fulltext !== undefined).sort((x, y) => x.ranks.fulltext! - y.ranks.fulltext!),
  };
  const uses = new Map<string, number>();
  const capped = (c: PoolCandidate) => (uses.get(sideKey(c.a)) ?? 0) >= perExchangeCap || (uses.get(sideKey(c.b)) ?? 0) >= perExchangeCap;
  // The cap keeps one long answer from filling a scarce budget. Spare capacity goes to capped
  // candidates too, still in rank order: leaving slots empty would help nobody.
  let capping = true;
  const nextOf = (path: "path_a" | "path_b") => {
    const list = lists[path];
    while (list.length > 0 && list[0].status === "selected") list.shift();
    return list.find((c) => c.status !== "selected" && !(capping && capped(c)));
  };

  const selected: PoolCandidate[] = [];
  const taken = { path_a: 0, path_b: 0 };
  while (selected.length < capacity) {
    const a = nextOf("path_a");
    const b = nextOf("path_b");
    if (!a && !b) {
      if (!capping) break;
      capping = false;
      continue;
    }
    // Whichever path is furthest behind its share goes next; ties go to Path A.
    const path = !b || (a && taken.path_a / pathAShare <= taken.path_b / (1 - pathAShare)) ? "path_a" : "path_b";
    const chosen = (path === "path_a" ? a : b)!;
    chosen.status = "selected";
    chosen.selectedBy = path;
    taken[path]++;
    selected.push(chosen);
    for (const s of [sideKey(chosen.a), sideKey(chosen.b)]) uses.set(s, (uses.get(s) ?? 0) + 1);
  }

  const deferred = eligible.filter((c) => c.status !== "selected");
  for (const c of deferred) c.deferredReason = c.exclusionReason ?? (capped(c) ? "cap" : "budget");
  for (const c of all) c.exclusionReason = null;
  const excluded: PoolCandidate[] = []; // nothing is excluded on a model's reading
  const candidates = [...selected, ...deferred];
  candidates.forEach((c, i) => (c.rank = i + 1));

  const target = Math.round(capacity * pathAShare);
  const targets = { path_a: target, path_b: capacity - target };
  return {
    candidates,
    counts: {
      selected: selected.length,
      deferred: deferred.length,
      excluded: excluded.length,
      pathA: all.filter((c) => c.sources.length === 1 && c.sources[0] === "topics").length,
      pathB: all.filter((c) => c.sources.length === 1 && c.sources[0] === "fulltext").length,
      both: all.filter((c) => c.sources.length === 2).length,
      selectedBy: { ...taken },
      targets,
      redistributed: Math.max(0, taken.path_a - targets.path_a) + Math.max(0, taken.path_b - targets.path_b),
    },
  };
}
