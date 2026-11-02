import type { QAPair } from "../transcript";

export const STOPWORDS = new Set([
  "i",
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "at",
  "it",
  "is",
  "was",
  "were",
  "be",
  "been",
  "my",
  "me",
  "we",
  "he",
  "she",
  "they",
  "that",
  "this",
  "with",
  "for",
  "you",
  "did",
  "do",
]);

// The transcript's capital "I" reads as a bar, joined to the next or last word ("|saw", "And|"). A
// bar is never testimony, so matching reads it as "I". The stored line keeps what OCR read.
export function normalize(text: string): string {
  return text
    .replace(/\|(?=[a-z])/g, "I ")
    .replace(/(?<=[a-z])\|/g, " I")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function quoteMatchScore(quote: string, answer: string): number {
  const q = normalize(quote);
  const a = normalize(answer);
  if (!q) return 0;
  if (a.includes(q)) return 1;

  const answerWords = new Set(a.split(" "));
  const quoteWords = q.split(" ").filter((word) => !STOPWORDS.has(word));
  if (quoteWords.length === 0) return 0;
  const found = quoteWords.filter((word) => answerWords.has(word)).length;
  return 0.9 * (found / quoteWords.length);
}

export function verifyQuote(
  quote: string,
  id: string,
  pairs: QAPair[],
): number {
  const pair = pairs.find((p) => p.id === id);
  if (!pair) return 0;
  return quoteMatchScore(quote, pair.answer);
}
