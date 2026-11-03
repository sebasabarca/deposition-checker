// Local neural embeddings as a retrieval path: the pure parts. What text each answer group is embedded
// as, how a long text is split into overlapping windows so nothing is truncated, how windows' token
// vectors become one item vector, and what a cached vector is keyed by. The model itself is loaded only
// in minilm.ts; nothing here does I/O, and nothing here knows the evaluation's passages.

import { createHash } from "node:crypto";

export const REPRESENTATIONS = ["qac", "qc", "a"] as const;
export type Representation = (typeof REPRESENTATIONS)[number];

// The same context the baseline paths read: the last 60 words of the group before.
export const CONTEXT_WORDS = 60;
export const lastWords = (text: string, n = CONTEXT_WORDS) => text.split(/\s+/).filter(Boolean).slice(-n).join(" ");

// Transcript speaker labels ("Q:", "A", "Ms. Name.", "WITNESS NAME:", "BY MR. NAME:"): form shared by all
// testimony, not content. A bare "Q" or "A" counts only at the start of a field and before a word that is
// not lowercase, so the article in "A car" stays.
const LABEL_AT_START = /^\s*(?:[QA](?:[:_.]|(?=\s+[^a-z]))|(?:Mr|Ms|Mrs|Dr)\.\s+[A-Z][A-Za-z'-]+\.|[A-Z][A-Z.' ]*[A-Z.]:)\s*/;
const LABEL_AFTER_SENTENCE = /([.?!"\-]\s+)(?:[QA][:_]|(?:Mr|Ms|Mrs|Dr)\.\s+[A-Z][A-Za-z'-]+\.(?=\s+[A-Z])|[A-Z][A-Z.' ]*[A-Z.]:)\s+/g;
export const stripSpeakerLabels = (text: string) => text.replace(LABEL_AT_START, "").replace(LABEL_AFTER_SENTENCE, "$1").trim();

type Texts = { question: string; answer: string; context: string };
// qac: question, answer and context (as the LSA path); qc: question and context (as the question path);
// a: the witness's own words only. strip: without speaker labels.
export function representationText(item: Texts, rep: Representation, strip = false): string {
  const f = strip ? stripSpeakerLabels : (s: string) => s;
  const ctx = f(lastWords(item.context));
  if (rep === "qac") return [f(item.question), f(item.answer), ctx].filter(Boolean).join(" ");
  if (rep === "qc") return [f(item.question), ctx].filter(Boolean).join(" ");
  return f(item.answer);
}

// Overlapping windows over a token sequence: every token is in at least one window, none longer than
// `size`. Consecutive windows share `overlap` tokens; the last one ends at the sequence's end.
export function windowsOf<T>(tokens: readonly T[], size: number, overlap: number): T[][] {
  if (size < 1 || overlap < 0 || overlap >= size) throw new Error("windowsOf: need size >= 1 and 0 <= overlap < size");
  if (tokens.length <= size) return [tokens.slice()];
  const out: T[][] = [];
  for (let start = 0; ; start += size - overlap) {
    if (start + size >= tokens.length) { out.push(tokens.slice(Math.max(0, tokens.length - size))); return out; }
    out.push(tokens.slice(start, start + size));
  }
}

// Sentence-transformers pooling for one sequence: the mean of its token vectors where the mask is set.
// hidden is [seqLen x dim], row-major.
export function meanPool(hidden: ArrayLike<number>, mask: ArrayLike<number>, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let count = 0;
  for (let t = 0; t < mask.length; t++) {
    if (!mask[t]) continue;
    count++;
    for (let j = 0; j < dim; j++) out[j] += hidden[t * dim + j];
  }
  if (count) for (let j = 0; j < dim; j++) out[j] /= count;
  return out;
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

// One item vector from its windows' (normalized) vectors, each weighted by its token count, normalized.
export function poolWindows(vectors: readonly Float32Array[], weights: readonly number[]): Float32Array {
  if (!vectors.length || vectors.length !== weights.length) throw new Error("poolWindows: one weight per window");
  const out = new Float32Array(vectors[0].length);
  vectors.forEach((v, i) => { for (let j = 0; j < v.length; j++) out[j] += weights[i] * v[j]; });
  return normalize(out);
}

// Every vector minus the corpus mean, renormalized: removes the direction all testimony shares (its
// question-and-answer form), which otherwise lifts every cosine alike.
export function centered(vectors: readonly Float32Array[]): Float32Array[] {
  if (!vectors.length) return [];
  const mean = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let j = 0; j < v.length; j++) mean[j] += v[j] / vectors.length;
  return vectors.map((v) => normalize(v.map((x, j) => x - mean[j])));
}

// A cached vector is valid only for the same source, model, revision, representation and windowing, and
// the same exact text (a context drawn from a neighbouring group can change without the source hash).
export type CacheKeyParts = { sourceHash: string; model: string; revision: string; representation: Representation; windowing: string; text: string };
export const cacheKey = (p: CacheKeyParts) =>
  [p.sourceHash, p.model, p.revision, p.representation, p.windowing, createHash("sha256").update(p.text).digest("hex").slice(0, 16)].join("|");

// Vectors stored as base64 Float32 in JSON caches.
export const encodeVector = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
export const decodeVector = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
