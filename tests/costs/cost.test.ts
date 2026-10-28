import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { callCost, PRICE_VERSION, PRICES, tokensFromUsage, V2_MODELS, type CallTokens } from "../../server/src/costs";
import { llmStage } from "../../server/src/db/schema";

const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const none: CallTokens = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
const cost = (model: string, tokens: Partial<CallTokens>, batch = false) => callCost(model, { ...none, ...tokens }, { batch })?.costUsd;

describe("callCost", () => {
  it("prices input and output tokens per million (DESIGN.md's 600 in / 300 out pair on Sonnet)", () => {
    expect(cost(SONNET, { input: 600, output: 300 })).toBe(0.0042); // 600 × $2 + 300 × $10, per million
    expect(cost(SONNET, { input: 1_000_000, output: 1_000_000 })).toBe(12);
    expect(cost(HAIKU, { input: 1_000, output: 1_000 })).toBe(0.0006); // $0.10 and $0.50
  });

  it("prices 5-minute and 1-hour cache writes at their own rates", () => {
    expect(cost(SONNET, { cacheWrite5m: 1_000 })).toBe(0.0025); // $2.50
    expect(cost(SONNET, { cacheWrite1h: 1_000 })).toBe(0.004); // $4
    expect(cost(HAIKU, { cacheWrite5m: 1_000 })).toBe(0.000125); // $0.125
    expect(cost(HAIKU, { cacheWrite1h: 1_000 })).toBe(0.0002); // $0.20
  });

  it("prices cache reads at the model's own rate (0.05x input on Sonnet 5.5, 0.1x on Haiku 5.5)", () => {
    expect(cost(SONNET, { cacheRead: 1_000 })).toBe(0.0001); // $0.10
    expect(cost(HAIKU, { cacheRead: 1_000 })).toBe(0.00001); // $0.01
  });

  it("adds every token type of one call", () => {
    // 2,000 × $2 + 500 × $10 + 1,000 × $2.50 + 200 × $4 + 10,000 × $0.10, per million
    expect(cost(SONNET, { input: 2_000, output: 500, cacheWrite5m: 1_000, cacheWrite1h: 200, cacheRead: 10_000 })).toBe(0.0133);
  });

  it("prices Haiku by prompt length: every token of a prompt over 100,000 tokens pays the higher rates", () => {
    expect(cost(HAIKU, { input: 100_000 })).toBe(0.01); // exactly at the limit: $0.10
    expect(cost(HAIKU, { input: 100_001 })).toBe(0.0500005); // over it: $0.50
    // Cache reads count toward the prompt's length, and the output pays the higher rate too:
    // 50,000 × $0.50 + 50,001 × $0.05 + 1,000 × $2.50, per million
    expect(cost(HAIKU, { input: 50_000, cacheRead: 50_001, output: 1_000 })).toBe(0.03000005);
  });

  it("halves every token type for the Batch API", () => {
    expect(cost(SONNET, { input: 600, output: 300 }, true)).toBe(0.0021);
    expect(cost(SONNET, { cacheWrite5m: 1_000, cacheRead: 1_000 }, true)).toBe(0.0013);
  });

  it("returns null for a model with no price, rather than a cost of zero", () => {
    expect(callCost("claude-unknown-9", { ...none, input: 1_000 })).toBeNull();
  });

  it("stamps the price version it used", () => {
    expect(callCost(SONNET, none)).toEqual({ costUsd: 0, priceVersion: PRICE_VERSION });
  });
});

describe("tokensFromUsage", () => {
  const usage = (fields: Partial<Anthropic.Usage>): Anthropic.Usage =>
    ({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      ...fields,
    }) as Anthropic.Usage;

  it("takes cache writes split by duration from the response", () => {
    const u = usage({
      cache_creation_input_tokens: 700,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 200 },
      cache_read_input_tokens: 3_000,
    });
    expect(tokensFromUsage(u)).toEqual({ input: 100, output: 50, cacheWrite5m: 500, cacheWrite1h: 200, cacheRead: 3_000 });
  });

  it("counts unsplit cache writes as 5-minute writes, the default duration, and missing counts as 0", () => {
    expect(tokensFromUsage(usage({ cache_creation_input_tokens: 700 }))).toMatchObject({ cacheWrite5m: 700, cacheWrite1h: 0 });
    expect(tokensFromUsage(usage({}))).toMatchObject({ cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  });
});

describe("configured models", () => {
  it("every model v2 is configured to call has a price", () => {
    for (const [stage, model] of Object.entries(V2_MODELS)) {
      expect(PRICES[model], `${stage}: ${model} has no price`).toBeDefined();
    }
  });

  it("the stages match the database's llm_stage values", () => {
    expect(Object.keys(V2_MODELS).sort()).toEqual([...llmStage.enumValues].sort());
  });
});
