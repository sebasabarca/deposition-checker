// Turns Path B's query matches into one ranked list of pairs of logical exchanges. Pure: no I/O.
//
// Retrieval searches exchange parts (a long answer is split into overlapping parts), but a
// candidate is a pair of logical exchanges, identified by (deposition, group). Every part pair of
// the same two logical exchanges, from either direction, is one candidate: it keeps the part pair
// with the best score, and those parts' IDs, which are the exact source references for evidence.

import { pairScore, type TermFrequency } from "./score";

export type Match = { source: number; target: number }; // part IDs: the query's part and a part it found

export type PartInfo = { id: number; depositionId: number; groupId: number; terms: readonly string[] };

export type LogicalExchange = { depositionId: number; groupId: number };

export type RankedPair = {
  rank: number; // 1 = most relevant
  score: number; // symmetric shared-vocabulary score (score.ts); retrieval relevance, not contradiction confidence
  a: LogicalExchange; // the logical exchange that sorts first by (deposition, group)
  b: LogicalExchange;
  exchangeA: number; // the representative part of a: the part pair with the best score
  exchangeB: number;
  sharedTerms: string[]; // the representative parts' shared terms, most distinctive first
  foundBy: "a" | "b" | "both"; // whose queries found any part pair of these two logical exchanges
};

const compareLogical = (x: LogicalExchange, y: LogicalExchange) => x.depositionId - y.depositionId || x.groupId - y.groupId;
const logicalKey = (x: LogicalExchange) => `${x.depositionId}:${x.groupId}`;

export function rankPairs(matches: readonly Match[], parts: ReadonlyMap<number, PartInfo>, weights: TermFrequency): RankedPair[] {
  const byPair = new Map<string, Omit<RankedPair, "rank">>();
  for (const m of matches) {
    const source = parts.get(m.source);
    const target = parts.get(m.target);
    if (!source || !target) throw new Error(`no terms for exchange part ${source ? m.target : m.source}`);
    // Orient by logical exchange, so either direction gives the same pair.
    const [first, second] = compareLogical(source, target) <= 0 ? [source, target] : [target, source];
    const a = { depositionId: first.depositionId, groupId: first.groupId };
    const b = { depositionId: second.depositionId, groupId: second.groupId };
    const from = first === source ? "a" : "b";
    const { score, sharedTerms } = pairScore(first.terms, second.terms, weights);

    const key = `${logicalKey(a)}|${logicalKey(b)}`;
    const seen = byPair.get(key);
    const candidate = { score, a, b, exchangeA: first.id, exchangeB: second.id, sharedTerms };
    if (!seen) {
      byPair.set(key, { ...candidate, foundBy: from });
      continue;
    }
    const foundBy = seen.foundBy === from ? from : "both";
    // The better part pair represents the candidate; on a tie, the lower part IDs, so it's stable.
    const better =
      score > seen.score ||
      (score === seen.score && (first.id - seen.exchangeA || second.id - seen.exchangeB) < 0);
    byPair.set(key, better ? { ...candidate, foundBy } : { ...seen, foundBy });
  }
  // Discovery only passes matches that meet the shared-terms rule; a pair scoring 0 is never a candidate.
  return [...byPair.values()]
    .filter((p) => p.score > 0)
    .sort((x, y) => y.score - x.score || compareLogical(x.a, y.a) || compareLogical(x.b, y.b))
    .map((p, i) => ({ rank: i + 1, ...p }));
}
