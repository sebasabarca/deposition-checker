import { describe, expect, it } from "vitest";
import { Aborted, caseRunSettings, ProviderLimiter, UNLIMITED, type Clock } from "../../server/src/jobs/limiter";

// A clock that only moves when someone sleeps on it.
function fakeClock() {
  const c = { t: 0, slept: [] as number[] };
  const clock: Clock = { now: () => c.t, sleep: async (ms) => { c.slept.push(ms); c.t += ms; } };
  return { c, clock };
}
const flush = () => new Promise((ok) => setImmediate(ok));

describe("provider limiter: slots", () => {
  it("hands a freed slot to the waiting run holding the fewest, then the oldest waiter", async () => {
    const l = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 3 });
    const big = await Promise.all([l.acquireSlot("big"), l.acquireSlot("big"), l.acquireSlot("big")]);
    const order: string[] = [];
    void l.acquireSlot("big").then((s) => { order.push("big"); return s; });
    const small = l.acquireSlot("small").then((s) => { order.push("small"); return s; });
    big[0].release();
    await small;
    expect(order).toEqual(["small"]); // big waited first but holds 2; small holds none
    big[1].release();
    await flush();
    expect(order).toEqual(["small", "big"]);
    expect(l.inFlight()).toBe(3);
  });

  it("never leaves a slot held: release is idempotent, and an aborted waiter takes nothing", async () => {
    const l = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 1 });
    const s = await l.acquireSlot("a");
    const stop = new AbortController();
    const waiting = l.acquireSlot("b", stop.signal);
    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(Aborted);
    s.release();
    s.release();
    expect(l.inFlight()).toBe(0);
    const again = await l.acquireSlot("c");
    expect(l.inFlight()).toBe(1);
    again.release();
  });
});

describe("provider limiter: token buckets", () => {
  it("paces requests per minute, including within the burst window", async () => {
    const { c, clock } = fakeClock();
    const l = new ProviderLimiter({ ...UNLIMITED, requestsPerMinute: 60, burstSeconds: 2 }, clock); // 1 a second, 2 at most at once
    for (let i = 0; i < 4; i++) await l.beforeSend({ input: 0, output: 0 });
    expect(c.t).toBe(2000); // two from the full bucket, then one a second
  });

  it("charges input from an estimate, corrected to uncached input plus cache writes; cache reads are free", async () => {
    const { c, clock } = fakeClock();
    const l = new ProviderLimiter({ ...UNLIMITED, inputTokensPerMinute: 60_000, burstSeconds: 10 }, clock); // 1,000 a second, 10,000 at most
    const t = await l.beforeSend({ input: 4_000, output: 0 });
    l.afterReply(t, { input_tokens: 9_000, output_tokens: 0, cache_creation_input_tokens: 1_000 }); // 10,000 used: the bucket is empty
    await l.beforeSend({ input: 1_000, output: 0 });
    expect(c.t).toBe(1_000);
    const u = await l.beforeSend({ input: 0, output: 0 });
    l.afterReply(u, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0 }); // cache reads aren't in the usage the limiter counts
    expect(c.t).toBe(1_000);
  });

  it("admits output against each request's worst case, so requests in flight can't together pass the limit", async () => {
    // Concurrent sleepers each wake at their own start + wait (the shared fake clock above would add them up).
    const c = { t: 0 };
    const clock: Clock = { now: () => c.t, sleep: async (ms) => { const end = c.t + ms; await flush(); c.t = Math.max(c.t, end); } };
    // 60,000 output tokens a minute (1 a millisecond), all available at once; each request may produce 25,000.
    const l = new ProviderLimiter({ ...UNLIMITED, outputTokensPerMinute: 60_000, burstSeconds: 60 }, clock);
    const at: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map(() => l.beforeSend({ input: 0, output: 25_000 }).then(() => at.push(c.t))));
    // Whenever one is admitted, the worst case of everything admitted so far fits in the bucket plus its refill,
    // even if none has replied yet: nothing is left to be discovered after completion.
    at.sort((x, y) => x - y).forEach((t, i) => expect((i + 1) * 25_000).toBeLessThanOrEqual(60_000 + t));
    expect(at.slice(0, 2)).toEqual([0, 0]);
    expect(at[2]).toBeGreaterThan(0); // a third would have allowed 75,000 at once
  });

  it("refunds unused output when the reply arrives, admitting the next request at once", async () => {
    const { c, clock } = fakeClock();
    const l = new ProviderLimiter({ ...UNLIMITED, outputTokensPerMinute: 60_000, burstSeconds: 60 }, clock);
    const a = await l.beforeSend({ input: 0, output: 30_000 });
    await l.beforeSend({ input: 0, output: 30_000 });
    l.afterReply(a, { input_tokens: 0, output_tokens: 3_000 }); // 27,000 back
    await l.beforeSend({ input: 0, output: 25_000 });
    expect(c.t).toBe(0);
  });

  it("refunds a rejected request in full, and keeps the whole charge when its outcome is unknown", async () => {
    const { c, clock } = fakeClock();
    const l = new ProviderLimiter({ ...UNLIMITED, outputTokensPerMinute: 60_000, burstSeconds: 60 }, clock);
    const rejected = await l.beforeSend({ input: 0, output: 60_000 });
    l.afterFailure(rejected, false);
    const unknown = await l.beforeSend({ input: 0, output: 60_000 });
    expect(c.t).toBe(0);
    l.afterFailure(unknown, true);
    await l.beforeSend({ input: 0, output: 30_000 });
    expect(c.t).toBe(30_000);
  });

  it("waits for a full bucket for a request larger than the bucket, then goes into debt", async () => {
    const { c, clock } = fakeClock();
    const l = new ProviderLimiter({ ...UNLIMITED, inputTokensPerMinute: 6_000, burstSeconds: 10 }, clock);
    await l.beforeSend({ input: 3_000, output: 0 }); // more than the 1,000 a full bucket holds: sent at once
    await l.beforeSend({ input: 100, output: 0 });
    expect(c.t).toBe(21_000); // -2,000 back to +100
  });

  it("pauses every request until a 429's retry-after has passed", async () => {
    const { c, clock } = fakeClock();
    const l = new ProviderLimiter(UNLIMITED, clock);
    l.pause(3_000);
    l.pause(1_000); // a shorter pause never shortens a longer one
    await Promise.all([l.beforeSend({ input: 0, output: 0 }), l.beforeSend({ input: 0, output: 0 })]);
    expect(c.t).toBeGreaterThanOrEqual(3_000);
    expect(l.stats.pauses).toBe(2);
  });

  it("charges nothing when aborted while waiting", async () => {
    const stop = new AbortController();
    const clock: Clock = { now: () => 0, sleep: async () => { stop.abort(); } };
    const l = new ProviderLimiter({ ...UNLIMITED, requestsPerMinute: 1, burstSeconds: 60 }, clock);
    await l.beforeSend({ input: 0, output: 0 });
    await expect(l.beforeSend({ input: 0, output: 0 }, stop.signal)).rejects.toBeInstanceOf(Aborted);
  });
});

describe("case-run settings", () => {
  it("defaults conservatively and reads the environment", () => {
    expect(caseRunSettings({})).toEqual({ packetsPerCase: 2, maxCases: 2, limits: { maxInFlight: 4, requestsPerMinute: 50, inputTokensPerMinute: 200_000, outputTokensPerMinute: 200_000, burstSeconds: 10 } });
    expect(caseRunSettings({ CASE_RUN_PACKETS_PER_CASE: "4", CASE_RUN_PACKETS_GLOBAL: "8", PROVIDER_REQUESTS_PER_MINUTE: "" }).limits).toMatchObject({ maxInFlight: 8, requestsPerMinute: 50 });
  });
  it("rejects nonsense", () => {
    expect(() => caseRunSettings({ CASE_RUN_PACKETS_PER_CASE: "0" })).toThrow();
    expect(() => caseRunSettings({ PROVIDER_INPUT_TOKENS_PER_MINUTE: "lots" })).toThrow();
    expect(() => caseRunSettings({ CASE_RUN_PACKETS_PER_CASE: "8", CASE_RUN_PACKETS_GLOBAL: "4" })).toThrow(/can't be more/);
  });
});
