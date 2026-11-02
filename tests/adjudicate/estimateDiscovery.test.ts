// The pre-check estimate: sized from the prompt's characters, never above the reserved worst case.
import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, estimateFromPromptChars } from "../../server/src/adjudicate/estimateDiscovery";

describe("discovery estimate", () => {
  it("sizes input from characters and keeps the typical cost under the reserved worst case", () => {
    const e = estimateFromPromptChars(351_446); // the Hutchinson pair
    expect(e.inputTokens).toBe(Math.ceil(351_446 / CHARS_PER_TOKEN));
    expect(e.typicalUsd).toBeGreaterThan(1);
    expect(e.typicalUsd).toBeLessThan(e.worstUsd);
    expect(e.fits).toBe(true);
  });

  it("says when testimony is too long for one request", () => {
    expect(estimateFromPromptChars(2_000_000).fits).toBe(false);
  });
});
