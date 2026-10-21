import type { QAPair } from "./transcript";

export function normalize(text: string): string {
  return text
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
  const quoteWords = q.split(" ");
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
