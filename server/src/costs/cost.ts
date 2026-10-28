// The cost of one model call, from its token counts and the price table. Pure: no I/O.

import type Anthropic from "@anthropic-ai/sdk";
import { BATCH_MULTIPLIER, PRICE_VERSION, PRICES, type Rates } from "./pricing";

export type CallTokens = {
  input: number; // uncached input only; cache reads and writes are counted separately
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

export type CallCost = { costUsd: number; priceVersion: string };

// Costs are kept to 8 decimal places (a hundredth of a microdollar), the precision of llm_calls.cost_usd.
const roundUsd = (usd: number) => Math.round(usd * 1e8) / 1e8;

// The token counts in an API response's `usage`. A response that reports cache writes without
// splitting them by duration is counted as 5-minute writes, the API's default duration.
export function tokensFromUsage(usage: Anthropic.Usage): CallTokens {
  const written = usage.cache_creation_input_tokens ?? 0;
  const split = usage.cache_creation;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheWrite5m: split ? split.ephemeral_5m_input_tokens : written,
    cacheWrite1h: split ? split.ephemeral_1h_input_tokens : 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
}

// Everything the model read: the prompt length that decides a tiered model's rates.
export const promptTokens = (t: CallTokens) => t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;

// The call's cost in USD, or null when the model has no price. A call without a price is never
// treated as free: the caller stores it as unpriced (cost_usd null), and totals report it.
export function callCost(model: string, tokens: CallTokens, { batch = false } = {}): CallCost | null {
  const tiers = PRICES[model];
  if (!tiers) return null;
  const prompt = promptTokens(tokens);
  const { rates } = tiers.find((t) => t.maxPromptTokens === null || prompt <= t.maxPromptTokens)!;
  const perMillion = (count: number, rate: number) => (count * rate) / 1_000_000;
  const parts: [number, keyof Rates][] = [
    [tokens.input, "input"],
    [tokens.cacheWrite5m, "cacheWrite5m"],
    [tokens.cacheWrite1h, "cacheWrite1h"],
    [tokens.cacheRead, "cacheRead"],
    [tokens.output, "output"],
  ];
  const usd = parts.reduce((sum, [count, kind]) => sum + perMillion(count, rates[kind]), 0);
  return { costUsd: roundUsd(batch ? usd * BATCH_MULTIPLIER : usd), priceVersion: PRICE_VERSION };
}
