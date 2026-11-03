// Independent retrieval over original testimony, for the retrieval feasibility probe (DESIGN.md, "Stage 2
// pivot"). Pure: no I/O, no model, no dependency. Nothing here reads Stage 2 facts, and nothing here
// knows the evaluation's passages: every rule is general.
//
// Items are logical answer groups. Each path turns items into vectors or anchor sets and returns, for
// every item, its best-scoring neighbours in other sessions; candidate pairs are deduplicated and ranked
// across the whole case, so a pair's global rank is what a review budget would see.

import { STOPWORDS } from "../verify";
import { COURTROOM_WORDS } from "./procedural";

export type Item = { id: number; session: number; question: string; answer: string; context: string };
export type Neighbour = { id: number; score: number };
export type Pair = { a: number; b: number; score: number };

const EXTRA_STOPWORDS = ["q", "a", "mr", "ms", "mrs", "dr", "is", "are", "be", "been", "being", "am", "not", "no", "yes", "so", "as", "if", "then", "than", "there", "here", "what", "which", "who", "whom", "when", "where", "why", "how", "any", "all", "some", "about", "into", "out", "up", "down", "over", "just", "also", "very", "can", "could", "would", "should", "will", "may", "might", "must", "your", "yours", "our", "us", "him", "his", "her", "hers", "them", "their", "its", "these", "those", "had", "has", "have", "do", "does", "said", "say", "says", "know", "think", "recall", "remember", "okay", "ok", "uh", "um", "huh", "yeah", "well", "right", "correct", "sir", "ma'am"];
const STOP = new Set([...STOPWORDS, ...EXTRA_STOPWORDS, ...COURTROOM_WORDS.flatMap((w) => w.toLowerCase().split(/\s+/))]);

// A light stemmer: plural and common verb endings, enough to join "escape", "escaped", "escaping".
export function stem(word: string): string {
  let w = word.replace(/'s$/, "");
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export const tokens = (text: string) =>
  (text.toLowerCase().match(/[a-z][a-z'-]*[a-z]|[a-z]/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem).filter((w) => w.length > 1 && !STOP.has(w));

// Sparse TF-IDF vectors (sublinear tf, L2-normalized). Terms in fewer than minDf items or more than
// maxDfShare of them carry no retrieval signal and are left out.
export type SparseVector = Map<number, number>;
export function tfidf(docs: readonly string[][], { minDf = 2, maxDfShare = 0.2 } = {}): { vectors: SparseVector[]; vocabulary: string[]; df: number[] } {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const vocabulary = [...df].filter(([, n]) => n >= minDf && n <= maxDfShare * docs.length).map(([t]) => t).sort();
  const index = new Map(vocabulary.map((t, i) => [t, i]));
  const n = docs.length;
  const vectors = docs.map((d) => {
    const tf = new Map<number, number>();
    for (const t of d) {
      const i = index.get(t);
      if (i !== undefined) tf.set(i, (tf.get(i) ?? 0) + 1);
    }
    const v: SparseVector = new Map();
    for (const [i, c] of tf) v.set(i, (1 + Math.log(c)) * Math.log(1 + n / df.get(vocabulary[i])!));
    const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
    for (const [i, x] of v) v.set(i, x / norm);
    return v;
  });
  return { vectors, vocabulary, df: vocabulary.map((t) => df.get(t)!) };
}

// Each item's k best neighbours in other sessions by sparse cosine, through an inverted index.
// rows: compute only these items' neighbours (the others get none), for full rankings of a few items.
export function sparseNeighbours(items: readonly Item[], vectors: readonly SparseVector[], k: number, eligible: (i: number) => boolean = () => true, rows?: ReadonlySet<number>): Neighbour[][] {
  const postings = new Map<number, [number, number][]>();
  vectors.forEach((v, d) => { if (eligible(d)) for (const [t, x] of v) (postings.get(t) ?? postings.set(t, []).get(t)!).push([d, x]); });
  return vectors.map((v, d) => {
    if (rows && !rows.has(d)) return [];
    const acc = new Map<number, number>();
    for (const [t, x] of v) for (const [e, y] of postings.get(t) ?? []) if (items[e].session !== items[d].session) acc.set(e, (acc.get(e) ?? 0) + x * y);
    return topK(acc, k);
  });
}

function topK(acc: Map<number, number>, k: number): Neighbour[] {
  return [...acc].filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, k).map(([i, score]) => ({ id: i, score }));
}

// Latent semantic analysis: a rank-`dims` truncated SVD of the TF-IDF matrix by randomized range
// finding, then each item as a normalized dense vector. A dependency-free stand-in for neural embeddings:
// it relates words that occur in similar testimony, not words that mean the same in general.
export function lsa(vectors: readonly SparseVector[], vocabularySize: number, { dims = 150, oversample = 20, powerIterations = 2, seed = 7 } = {}): Float64Array[] {
  const n = vectors.length;
  const l = Math.min(dims + oversample, n, vocabularySize);
  let s = seed;
  const random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const omega = Array.from({ length: vocabularySize }, () => Float64Array.from({ length: l }, random));
  // Y = A * Omega (n x l)
  const multA = (m: Float64Array[]) => vectors.map((v) => { const out = new Float64Array(l); for (const [t, x] of v) { const row = m[t]; for (let j = 0; j < l; j++) out[j] += x * row[j]; } return out; });
  // Z = A^T * Y (V x l)
  const multAt = (y: Float64Array[]) => { const z = Array.from({ length: vocabularySize }, () => new Float64Array(l)); vectors.forEach((v, d) => { const row = y[d]; for (const [t, x] of v) { const zt = z[t]; for (let j = 0; j < l; j++) zt[j] += x * row[j]; } }); return z; };
  let y = orthonormalize(multA(omega), l);
  for (let q = 0; q < powerIterations; q++) y = orthonormalize(multA(orthonormalize(multAt(y), l)), l);
  // B = Y^T A (l x V); its left singular vectors come from B B^T (l x l), symmetric.
  const bt = multAt(y); // V x l, B transposed
  const bbt = Array.from({ length: l }, () => new Float64Array(l));
  for (const row of bt) for (let i = 0; i < l; i++) { const ri = row[i]; if (ri === 0) continue; for (let j = i; j < l; j++) bbt[i][j] += ri * row[j]; }
  for (let i = 0; i < l; i++) for (let j = 0; j < i; j++) bbt[i][j] = bbt[j][i];
  const { values, vectors: ub } = jacobiEigen(bbt);
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, Math.min(dims, l)).map(([, i]) => i);
  return y.map((row) => {
    const out = new Float64Array(order.length);
    order.forEach((c, k) => { let sum = 0; for (let i = 0; i < l; i++) sum += row[i] * ub[i][c]; out[k] = sum * Math.sqrt(Math.max(values[c], 0)); });
    const norm = Math.sqrt(out.reduce((a, x) => a + x * x, 0)) || 1;
    for (let k = 0; k < out.length; k++) out[k] /= norm;
    return out;
  });
}

function orthonormalize(m: Float64Array[], cols: number): Float64Array[] {
  const n = m.length;
  const q = m.map((r) => Float64Array.from(r));
  for (let j = 0; j < cols; j++) {
    for (let k = 0; k < j; k++) { let dot = 0; for (let i = 0; i < n; i++) dot += q[i][j] * q[i][k]; for (let i = 0; i < n; i++) q[i][j] -= dot * q[i][k]; }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += q[i][j] * q[i][j];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < n; i++) q[i][j] /= norm;
  }
  return q;
}

// Eigenvalues and eigenvectors (columns) of a small symmetric matrix, by cyclic Jacobi rotations.
export function jacobiEigen(input: Float64Array[]): { values: number[]; vectors: Float64Array[] } {
  const n = input.length;
  const a = input.map((r) => Float64Array.from(r));
  const v = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k][p]; const akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k]; const aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = v[k][p]; const vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

// Each item's k best neighbours in other sessions by dense cosine (vectors already normalized).
export function denseNeighbours(items: readonly Item[], vectors: readonly Float64Array[], k: number, eligible: (i: number) => boolean = () => true, rows?: ReadonlySet<number>): Neighbour[][] {
  return vectors.map((v, d) => {
    if (rows && !rows.has(d)) return [];
    const acc = new Map<number, number>();
    vectors.forEach((w, e) => { if (e === d || !eligible(e) || items[e].session === items[d].session) return; let s = 0; for (let j = 0; j < v.length; j++) s += v[j] * w[j]; acc.set(e, s); });
    return topK(acc, k);
  });
}

// Anchors: what ties testimony to an occasion, read from the words alone: capitalized names (runs of
// capitalized words not at a sentence's start, or known not to be common words), months with their day,
// years, weekdays and numbers. No list of the case's names.
const MONTH = /^(?:January|February|March|April|May|June|July|August|September|October|November|December)$/;
const WEEKDAY = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
const NOT_NAMES = new Set(["I", "Q", "A", "Mr", "Ms", "Mrs", "Dr", "Okay", "Yes", "No", "And", "But", "So", "The", "It", "That", "This", "He", "She", "We", "They", "You", "Did", "Do", "Does", "Was", "Were", "Is", "Are", "What", "When", "Where", "Who", "Why", "How", "Well", "Now", "Then", "Oh", "Sir", "Objection", "BY", "THE", "WITNESS"]);
const TITLE = /^(?:Mr|Ms|Mrs|Dr|St|Jr|Sr)\.$/;
const wordsOf = (text: string) => text.replace(/[“”"]/g, " ").split(/\s+/).filter(Boolean);
const bare = (w: string) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, "").replace(/'s$/, "");
const startsSentence = (words: string[], i: number) => i === 0 || (/[.?!:]$/.test(words[i - 1]) && !TITLE.test(words[i - 1]));

// The words a corpus capitalizes in mid-sentence: names. A word at a sentence's start counts as a name only
// if it is one of these, so "On" or "After" never does, and "Ortiz met …" still does.
export function nameVocabulary(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const t of texts) {
    const words = wordsOf(t);
    words.forEach((w, i) => { const raw = bare(w); if (/^[A-Z][a-z'-]+$/.test(raw) && !NOT_NAMES.has(raw) && !startsSentence(words, i)) names.add(raw); });
  }
  return names;
}

export function anchors(text: string, names?: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const words = wordsOf(text);
  for (let i = 0; i < words.length; i++) {
    const raw = bare(words[i]);
    if (!raw) continue;
    const sentenceStart = startsSentence(words, i);
    if (MONTH.test(raw)) {
      const day = (words[i + 1] ?? "").match(/^(\d{1,2})(?:st|nd|rd|th)?\b/);
      out.add(`date:${raw.toLowerCase()}${day ? ` ${Number(day[1])}` : ""}`);
      continue;
    }
    if (WEEKDAY.test(raw)) { out.add(`day:${raw.toLowerCase()}`); continue; }
    if (/^(?:19|20)\d\d$/.test(raw)) { out.add(`year:${raw}`); continue; }
    if (/^[A-Z][a-z'-]+$/.test(raw) && !NOT_NAMES.has(raw) && (!sentenceStart || (names ?? nameVocabulary([text])).has(raw))) out.add(`name:${stem(raw.toLowerCase())}`);
    if (/^[A-Z]{2,}$/.test(raw) && raw.length <= 6 && !NOT_NAMES.has(raw)) out.add(`name:${raw.toLowerCase()}`);
  }
  return [...out];
}

// Anchor overlap, weighted by rarity (IDF): sum over shared anchors, each item's own anchors counting
// fully and its context's at half. Inverted index; other sessions only.
export function anchorNeighbours(items: readonly Item[], own: readonly string[][], context: readonly string[][], k: number, eligible: (i: number) => boolean = () => true, rows?: ReadonlySet<number>): Neighbour[][] {
  const weights = items.map((_, d) => { const w = new Map<string, number>(); for (const x of context[d]) w.set(x, 0.5); for (const x of own[d]) w.set(x, 1); return w; });
  const df = new Map<string, number>();
  for (const w of weights) for (const x of w.keys()) df.set(x, (df.get(x) ?? 0) + 1);
  const n = items.length;
  const idf = (x: string) => Math.log(1 + n / (df.get(x) ?? 1));
  const postings = new Map<string, [number, number][]>();
  weights.forEach((w, d) => { if (eligible(d)) for (const [x, y] of w) (postings.get(x) ?? postings.set(x, []).get(x)!).push([d, y]); });
  return weights.map((w, d) => {
    if (rows && !rows.has(d)) return [];
    const acc = new Map<number, number>();
    // Anchors in more than 5% of a large case (a witness's own name, the case's main place) say nothing.
    for (const [x, y] of w) { if ((df.get(x) ?? 0) > Math.max(20, n * 0.05)) continue; for (const [e, z] of postings.get(x) ?? []) if (items[e].session !== items[d].session) acc.set(e, (acc.get(e) ?? 0) + y * z * idf(x)); }
    return topK(acc, k);
  });
}

// Every item's neighbours as unordered pairs, each kept once with its best score, ranked across the case.
export function rankPairs(neighbours: readonly Neighbour[][]): Pair[] {
  const best = new Map<string, Pair>();
  neighbours.forEach((ns, a) => { for (const { id: b, score } of ns) { const [x, y] = a < b ? [a, b] : [b, a]; const key = `${x}:${y}`; if (!best.has(key) || best.get(key)!.score < score) best.set(key, { a: x, b: y, score }); } });
  return [...best.values()].sort((p, q) => q.score - p.score || p.a - q.a || p.b - q.b);
}

// Reciprocal-rank fusion of ranked pair lists: each list contributes 1 / (k + rank) to a pair it holds.
export function fuse(lists: readonly Pair[][], k = 60): Pair[] {
  const scores = new Map<string, Pair>();
  for (const list of lists) list.forEach((p, r) => { const key = `${p.a}:${p.b}`; const s = 1 / (k + r + 1); const cur = scores.get(key); scores.set(key, { a: p.a, b: p.b, score: (cur?.score ?? 0) + s }); });
  return [...scores.values()].sort((p, q) => q.score - p.score || p.a - q.a || p.b - q.b);
}

// The best (1-based) rank of a pair joining one item of `left` and one of `right`, or null.
export function pairRank(pairs: readonly Pair[], left: ReadonlySet<number>, right: ReadonlySet<number>): number | null {
  const i = pairs.findIndex((p) => (left.has(p.a) && right.has(p.b)) || (left.has(p.b) && right.has(p.a)));
  return i < 0 ? null : i + 1;
}

// The (1-based) rank of the first item of `target` among an item's full ranking, or null.
export function queryRank(ranking: readonly Neighbour[], target: ReadonlySet<number>): number | null {
  const i = ranking.findIndex((x) => target.has(x.id));
  return i < 0 ? null : i + 1;
}
