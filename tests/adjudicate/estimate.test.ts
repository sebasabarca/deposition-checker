import { describe, expect, it } from "vitest";
import { coldCacheCost, expectedPacketCost, measure, MIN_MEASURED_CALLS } from "../../server/src/adjudicate/estimate";
import { maxPacketCost, MAX_OUTPUT_TOKENS } from "../../server/src/adjudicate";

const sample = (packetChars: number, input: number, output: number) => ({ packetChars, input, output, cacheRead: 2738, cacheWrite5m: 0 });

describe("adjudication cost estimate", () => {
  it("gives no expected cost until enough calls are measured", () => {
    expect(measure(Array.from({ length: MIN_MEASURED_CALLS - 1 }, () => sample(2000, 800, 400)))).toBeNull();
  });

  it("estimates from measured rates and prices with the provider's token types", () => {
    const m = measure([sample(2000, 800, 400), sample(3000, 1200, 500), sample(1000, 400, 450), sample(2000, 800, 420)])!;
    expect(m.inputTokensPerChar).toBeCloseTo(0.4, 6);
    expect(m.outputTokens).toEqual({ median: 435, max: 500 });
    const e = expectedPacketCost("claude-sonnet-5-5", 2500, m)!;
    // 1,000 input at $2/M, 2,738 cache reads at $0.10/M, output at $10/M.
    expect(e.median).toBeCloseTo((1000 * 2 + 2738 * 0.1 + 435 * 10) / 1e6, 8);
    expect(e.high).toBeCloseTo((1000 * 2 + 2738 * 0.1 + 500 * 10) / 1e6, 8);
    expect(coldCacheCost("claude-sonnet-5-5", m)).toBeCloseTo((2738 * (2.5 - 0.1)) / 1e6, 8);
  });

  it("reserves the configured output allowance, which covers thinking, never a measured average", () => {
    expect(maxPacketCost("claude-sonnet-5-5", "")).toBeGreaterThanOrEqual((MAX_OUTPUT_TOKENS * 10) / 1e6);
  });
});
