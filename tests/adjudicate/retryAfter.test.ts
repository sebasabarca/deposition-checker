import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { classifyFailure, DEFAULT_RETRY_AFTER_MS, retryAfterMsOf } from "../../server/src/adjudicate/requests";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const limited = (headers: Record<string, string>, body: object = { type: "error", error: { type: "rate_limit_error", message: "slow down" } }) => new Anthropic.RateLimitError(429, body, "rate limited", new Headers(headers));

describe("how long the provider asked us to wait", () => {
  it("uses retry-after seconds first", () => {
    expect(retryAfterMsOf(new Headers({ "retry-after": "7", "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": "2026-11-04T12:01:00Z" }), NOW)).toBe(7_000);
  });
  it("otherwise the latest reset of a limit with nothing left", () => {
    const h = new Headers({
      "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": "2026-11-04T12:00:05Z",
      "anthropic-ratelimit-input-tokens-remaining": "0", "anthropic-ratelimit-input-tokens-reset": "2026-11-04T12:00:12Z",
      "anthropic-ratelimit-output-tokens-remaining": "40000", "anthropic-ratelimit-output-tokens-reset": "2026-11-04T12:00:59Z",
    });
    expect(retryAfterMsOf(h, NOW)).toBe(12_000);
  });
  it("is null when the headers say nothing usable", () => {
    expect(retryAfterMsOf(new Headers({ "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": "2026-11-04T11:59:00Z" }), NOW)).toBeNull();
    expect(retryAfterMsOf(undefined, NOW)).toBeNull();
  });
});

describe("classifying a 429", () => {
  it("a rate limit waits for the provider's time, or the default", () => {
    expect(classifyFailure(limited({ "retry-after": "3" }), NOW)).toMatchObject({ kind: "rate_limited", status: "rate_limited", retryAfterMs: 3_000, billable: false });
    expect(classifyFailure(limited({}), NOW).retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });
  it("the monthly spend cap is not retryable and was not billed", () => {
    const cap = limited({}, { type: "error", error: { type: "rate_limit_error", message: "usage limits", details: { error_code: "enforced_spend_limit_reached" } } });
    expect(classifyFailure(cap, NOW)).toEqual({ kind: "spend_limit", status: "failed", retryAfterMs: null, billable: false });
  });
  it("a 529 is an overload, retried like a rate limit", () => {
    const e = new Anthropic.APIError(529, { type: "error", error: { type: "overloaded_error" } }, "overloaded", new Headers());
    expect(classifyFailure(e, NOW)).toMatchObject({ kind: "overloaded", status: "rate_limited", retryAfterMs: DEFAULT_RETRY_AFTER_MS, billable: true });
  });
});
