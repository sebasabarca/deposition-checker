// The final score of a candidate pair: how much of the smaller exchange's distinctive vocabulary
// the other exchange shares. Pure: no I/O. It is retrieval relevance, never contradiction confidence.
//
// Each content term is weighted by its rarity in the case, idf = ln(N / df): N is the number of
// logical exchanges in the case and df how many of them use the term, so a word every exchange uses
// weighs 0 and a rare one weighs most. The score is the weighted overlap coefficient: the squared
// weights of the shared terms, divided by the smaller of the two exchanges' squared weight totals.
// It is symmetric, between 0 and 1, and depends only on the two exchanges, never on which query
// found the pair or how many terms it had, so scores are comparable across pairs. Pairs sharing
// fewer than MIN_SHARED_TERMS terms with any weight score 0: one shared word is too little to go on,
// and a word every exchange uses doesn't count toward it.
//
// Dividing by the smaller exchange suits testimony: a contradiction is often a short question and
// answer that echoes part of a long answer, and that pair should score high. Alternatives measured
// on Ellison P3171 against P3173 before choosing (docs/agent-log.md): plain Jaccard weighs every word
// alike ("Oracle" as much as "outsourcing") and divides by the union, so short-against-long pairs score
// near zero; cosine on the same weights let short exchanges sharing one uncommon word ("familiar",
// "brand") fill the top; the plain sum of shared weights let the longest answers fill it.

export const MIN_SHARED_TERMS = 2;

export type TermFrequency = { exchanges: number; frequency: ReadonlyMap<string, number> };

// A term's weight. A term missing from the table is treated as used once, the rarest possible.
export function idf(term: string, { exchanges, frequency }: TermFrequency): number {
  const df = Math.max(1, frequency.get(term) ?? 1);
  return Math.max(0, Math.log(exchanges / df));
}

export type PairScore = { score: number; sharedTerms: string[] };

// The shared terms that carry weight come back most distinctive first, as the explanation of the score.
//
// Every sum runs over terms in sorted order, so the same two exchanges always give exactly the same
// number in either order: the score is symmetric and stable without rounding, and any pair meeting
// the shared-terms rule scores above 0.
export function pairScore(a: readonly string[], b: readonly string[], weights: TermFrequency): PairScore {
  const w2 = (t: string) => idf(t, weights) ** 2;
  const total = (terms: readonly string[]) => terms.reduce((sum, t) => sum + w2(t), 0);
  const setA = [...new Set(a)].sort();
  const inB = new Set(b);
  const setB = [...inB].sort();
  const shared = setA.filter((t) => inB.has(t));
  const smaller = Math.min(total(setA), total(setB));
  const weighted = shared.filter((t) => w2(t) > 0).length;
  const score = weighted < MIN_SHARED_TERMS || smaller === 0 ? 0 : total(shared) / smaller;
  // Only the terms that contribute to the score are reported; a word every exchange uses adds nothing.
  const contributing = shared.filter((t) => w2(t) > 0);
  return { score, sharedTerms: contributing.sort((x, y) => w2(y) - w2(x) || x.localeCompare(y)) };
}
