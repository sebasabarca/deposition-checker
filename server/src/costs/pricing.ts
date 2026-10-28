// Model prices in USD per million tokens (DESIGN.md, "Cost model"), from
// https://platform.claude.com/docs/en/about-claude/pricing as checked on the date of PRICE_VERSION.
// When a price changes, add the new prices under a new PRICE_VERSION: every recorded call stores the
// version it was priced with, so changing prices never rewrites the cost of past calls.
//
// Not modelled, because v2 never uses them: US-only inference (`inference_geo`, 1.1x), fast mode,
// and server-side tools such as web search.

export const PRICE_VERSION = "2026-10-28";

// The Batch API halves every token type, cache reads and writes included.
export const BATCH_MULTIPLIER = 0.5;

export type Rates = {
  input: number;
  cacheWrite5m: number; // 1.25x input
  cacheWrite1h: number; // 2x input
  cacheRead: number; // 0.1x input on most models; 0.05x on Sonnet 5.5
  output: number;
};

// A model's rates can depend on the prompt's length (Claude Haiku 5.5). Tiers are in increasing
// order; a request is priced by the first tier whose limit its prompt doesn't exceed, and every
// token in it pays that tier's rates.
export type PriceTier = { maxPromptTokens: number | null; rates: Rates };

export const PRICES: Record<string, PriceTier[]> = {
  "claude-sonnet-5-5": [
    { maxPromptTokens: null, rates: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 } },
  ],
  "claude-haiku-5-5": [
    { maxPromptTokens: 100_000, rates: { input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 } },
    { maxPromptTokens: null, rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 } },
  ],
};
