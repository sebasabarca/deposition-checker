// Local reranking of a candidate pool (frozen.ts) by a pair classifier: the pure parts. What text a passage is
// scored as, how two long passages are split into windows so nothing is truncated, how the two directions and the
// windows' scores become one pair score, and how scores reorder a pool. A rerank only orders: every input
// candidate is in the output, so a pair the model scores low is deferred, never deleted. The models are loaded
// only in rerankModels.ts; nothing here does I/O or reads benchmark labels.

import { lastWords, stripSpeakerLabels, windowsOf } from "./embeddings";
import { pairKey, type Candidate, type CandidatePool } from "./frozen";

export const RERANK_CONTEXT_WORDS = 30;
export const RRF_K = 60;

// Question and answer without speaker labels, after the last few words of the group before (a yes/no answer
// needs its question; a little context names what "it" is).
export const rerankText = (item: { question: string; answer: string; context: string }, contextWords = RERANK_CONTEXT_WORDS) =>
  [lastWords(stripSpeakerLabels(item.context), contextWords), stripSpeakerLabels(item.question), stripSpeakerLabels(item.answer)].filter(Boolean).join(" ");

// Window pairs for one cross-encoder input of at most `maxLen` tokens ([CLS] a [SEP] b [SEP]): whole sides when
// they fit, otherwise each long side cut into overlapping windows (a short side keeps its full length and the
// long side gets the rest) and every window of a scored with every window of b.
export function pairWindows<T>(a: readonly T[], b: readonly T[], maxLen: number, overlap = 32): [T[], T[]][] {
  const room = maxLen - 3;
  if (room < 2) throw new Error("pairWindows: maxLen too small");
  if (a.length + b.length <= room) return [[a.slice(), b.slice()]];
  const half = Math.floor(room / 2);
  const sa = a.length <= half ? a.length : b.length <= half ? room - b.length : half;
  const sb = room - sa;
  const win = (s: readonly T[], size: number) => (s.length ? windowsOf(s, size, Math.min(overlap, size - 1)) : [[]]);
  const wa = win(a, sa), wb = win(b, sb);
  return wa.flatMap((x) => wb.map((y) => [x, y] as [T[], T[]]));
}

export function softmax(logits: readonly number[]): number[] {
  const m = Math.max(...logits);
  const e = logits.map((x) => Math.exp(x - m));
  const s = e.reduce((x, y) => x + y, 0);
  return e.map((x) => x / s);
}

// One pair score from both directions' window scores: the strongest window in either direction, since one
// contradicting or relevant span is what makes a pair worth reading.
export const pairScore = (ab: readonly number[], ba: readonly number[]) => Math.max(...ab, ...ba);

export type PairScores = ReadonlyMap<string, number>; // pairKey -> score

// Contradiction about the same thing: the NLI model's P(contradiction) times the relevance cross-encoder's
// probability that the passages concern each other. The small NLI model calls most unrelated passages a
// contradiction too, so P(contradiction) alone cannot tell "different subject" from "conflicting answer".
export const relatedContradiction = (pContradiction: number, relevanceLogit: number) => pContradiction / (1 + Math.exp(-relevanceLogit));

// The pool reordered by score, highest first; ties (and candidates without a score, last) keep pool order.
export function orderByScore(pool: CandidatePool, scores: PairScores, name: string): CandidatePool {
  const s = (c: Candidate) => scores.get(pairKey(c.a, c.b)) ?? -Infinity;
  const idx = new Map(pool.candidates.map((c, i) => [c, i]));
  return { ...pool, name, candidates: [...pool.candidates].sort((x, y) => s(y) - s(x) || idx.get(x)! - idx.get(y)!) };
}

// Each item's best-scored partners first: a pair's place is its better rank among either side's candidates (by
// score), then its score. A passage that scores high with every partner (a name or job question across
// witnesses) then fills one slot per rank, not the top of the list.
export function perItemOrder(pool: CandidatePool, scores: PairScores, name: string): CandidatePool {
  const s = (c: Candidate) => scores.get(pairKey(c.a, c.b)) ?? -Infinity;
  const byItem = new Map<string, Candidate[]>();
  for (const c of pool.candidates) for (const k of [c.a, c.b]) (byItem.get(k) ?? byItem.set(k, []).get(k)!).push(c);
  const best = new Map<Candidate, number>();
  for (const list of byItem.values()) [...list].sort((x, y) => s(y) - s(x)).forEach((c, r) => best.set(c, Math.min(best.get(c) ?? Infinity, r + 1)));
  // Rank first, score second: one number with the score scaled below one rank step.
  const span = Math.max(...pool.candidates.map((c) => Math.abs(s(c))).filter(Number.isFinite), 1);
  return orderByScore(pool, new Map(pool.candidates.map((c) => [pairKey(c.a, c.b), -best.get(c)! + (Number.isFinite(s(c)) ? s(c) / (4 * span) : -0.5)])), name);
}

// Reciprocal-rank fusion of the pool's own order with one or more score orders: retrieval keeps its say, and the
// model can lift a pair, never remove it.
export function fuseOrders(pool: CandidatePool, orders: readonly CandidatePool[], name: string, k = RRF_K): CandidatePool {
  const score = new Map<string, number>();
  for (const o of [pool, ...orders]) o.candidates.forEach((c, r) => { const id = pairKey(c.a, c.b); score.set(id, (score.get(id) ?? 0) + 1 / (k + r + 1)); });
  return orderByScore(pool, score, name);
}

// Cross-path agreement, the existing label-free baseline (retrieval-triage-sweep.ts): how many paths rank the
// pair within their top `k` in either direction, then pool order.
export function agreementOrder(pool: CandidatePool, name: string, k = 3): CandidatePool {
  const score = new Map(pool.candidates.map((c, i) => [pairKey(c.a, c.b), Object.values(c.ranks).filter(([ab, ba]) => Math.min(ab ?? Infinity, ba ?? Infinity) <= k).length - i / (pool.candidates.length + 1)]));
  return orderByScore(pool, score, name);
}

// Whether a reordered pool still holds exactly the input's candidates (the rerank never deletes).
export const sameCandidates = (x: CandidatePool, y: CandidatePool) => {
  if (x.candidates.length !== y.candidates.length) return false;
  const ids = new Set(x.candidates.map((c) => pairKey(c.a, c.b)));
  return y.candidates.every((c) => ids.has(pairKey(c.a, c.b)));
};
