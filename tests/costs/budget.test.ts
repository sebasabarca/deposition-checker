import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { failureIsUnbilled, inputTokenBound, maxRequestCost } from "../../server/src/costs";

describe("maxRequestCost", () => {
  it("bounds a request at every input token at the 5-minute cache-write rate and output at max_tokens", () => {
    // Sonnet 5.5: input-side worst rate $2.50, output $10, per million
    expect(maxRequestCost("claude-sonnet-5-5", { inputTokens: 10_000, maxOutputTokens: 8_000 })).toBeCloseTo((10_000 * 2.5 + 8_000 * 10) / 1e6, 8);
    // Haiku 5.5 under 100K prompt tokens: $0.125 and $0.50
    expect(maxRequestCost("claude-haiku-5-5", { inputTokens: 12_000, maxOutputTokens: 16_000 })).toBeCloseTo((12_000 * 0.125 + 16_000 * 0.5) / 1e6, 8);
    // over 100K: the higher tier
    expect(maxRequestCost("claude-haiku-5-5", { inputTokens: 200_000, maxOutputTokens: 0 })).toBeCloseTo((200_000 * 0.625) / 1e6, 8);
  });

  it("refuses to bound a model without a price, so such a call is never sent", () => {
    expect(() => maxRequestCost("claude-unknown-9", { inputTokens: 1, maxOutputTokens: 1 })).toThrow("No price");
  });

  it("never estimates fewer input tokens than characters", () => {
    expect(inputTokenBound(12_345)).toBe(12_345);
  });
});

describe("failureIsUnbilled", () => {
  const apiError = (status: number) => Object.assign(Object.create(Anthropic.APIError.prototype), { status });
  it("treats only a 4xx rejection as certainly unbilled", () => {
    expect(failureIsUnbilled(apiError(400))).toBe(true);
    expect(failureIsUnbilled(apiError(429))).toBe(true);
    expect(failureIsUnbilled(apiError(500))).toBe(false);
    expect(failureIsUnbilled(apiError(529))).toBe(false);
    expect(failureIsUnbilled(new Error("timeout"))).toBe(false);
  });
});
