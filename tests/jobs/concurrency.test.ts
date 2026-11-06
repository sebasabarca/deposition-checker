// Output caps and adaptive concurrency (both off by default): settings, the one cap function, the request the
// packet client sends with it, and the limiter's AIMD window. No API key, no database.

import { describe, expect, it } from "vitest";
import { anthropicPacketAdjudicator, packetMaxTokens, packetRequestParams } from "../../server/src/adjudicate/packetModel";
import { maxOutputTokensFor } from "../../server/src/adjudicate/packetPrompt";
import { caseRunSettings, PROVIDER_TIERS, ProviderLimiter, UNLIMITED, type Clock } from "../../server/src/jobs/limiter";

const clockAt = () => { const c = { t: 0 }; const clock: Clock = { now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return { c, clock }; };
const flush = () => new Promise((ok) => setImmediate(ok));

describe("output cap per request", () => {
  it("keeps the default unless a lower per-pair cap is given, and never raises it", () => {
    for (const pairs of [1, 3, 8, 30]) expect(packetMaxTokens(pairs)).toBe(maxOutputTokensFor(pairs));
    expect(packetMaxTokens(8, 1_200)).toBe(9_600);
    expect(packetMaxTokens(1, 5_500)).toBe(5_500);
    expect(() => packetMaxTokens(1, 5_501)).toThrow(/1 to 5500/);
    expect(() => packetMaxTokens(1, 0)).toThrow();
    expect(() => packetMaxTokens(1, 1.5)).toThrow();
  });

  it("sends exactly the cap it is given as max_tokens; the default request is unchanged", async () => {
    expect(packetRequestParams("x", 3).max_tokens).toBe(maxOutputTokensFor(3));
    const sent: { max_tokens: number }[] = [];
    const client = { messages: { stream: (params: { max_tokens: number }) => { sent.push(params); return { request_id: "r", finalMessage: async () => ({ model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "{}" }] }) }; } } };
    const a = anthropicPacketAdjudicator(client as never);
    await a.adjudicate("packet", 4, { maxOutputTokens: packetMaxTokens(4, 900) });
    await a.adjudicate("packet", 4);
    expect(sent.map((p) => p.max_tokens)).toEqual([3_600, maxOutputTokensFor(4)]);
  });
});

describe("case run settings: tiers, caps, adaptive", () => {
  it("default settings are exactly as before (no tier, no cap, not adaptive)", () => {
    expect(caseRunSettings({}).limits).toEqual({ maxInFlight: 4, requestsPerMinute: 50, inputTokensPerMinute: 200_000, outputTokensPerMinute: 200_000, burstSeconds: 10 });
  });
  it("a tier preset sets the three limits; an explicit limit wins", () => {
    expect(caseRunSettings({ PROVIDER_TIER: "2" }).limits).toMatchObject(PROVIDER_TIERS["2"]);
    expect(caseRunSettings({ PROVIDER_TIER: "4", PROVIDER_OUTPUT_TOKENS_PER_MINUTE: "123" }).limits).toMatchObject({ requestsPerMinute: 4_000, outputTokensPerMinute: 123 });
    expect(() => caseRunSettings({ PROVIDER_TIER: "5" })).toThrow();
  });
  it("reads per-contract caps and adaptive; rejects a cap above the default", () => {
    expect(caseRunSettings({ PACKET_OUTPUT_TOKENS_PER_PAIR: "1200", CASE_RUN_ADAPTIVE: "true" }).limits).toMatchObject({ adaptive: true, outputTokensPerPair: { "packet-v1": 1_200 } });
    expect(caseRunSettings({ STRETCH_OUTPUT_TOKENS_PER_PAIR: "700" }).limits.outputTokensPerPair).toEqual({ "stretch-v2": 700 });
    expect(() => caseRunSettings({ PACKET_OUTPUT_TOKENS_PER_PAIR: "6000" })).toThrow();
    expect(() => caseRunSettings({ CASE_RUN_ADAPTIVE: "yes" })).toThrow();
  });
});

describe("provider limiter: adaptive window", () => {
  it("halves on repeated 429s (once per pause), ignores a lone one, grows back by about one per window of replies", async () => {
    const { c, clock } = clockAt();
    const l = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 8, adaptive: true }, clock);
    expect(l.capacity()).toBe(8);
    l.pause(1_000); // a lone 429: the pause alone handles it
    expect(l.capacity()).toBe(8);
    c.t = 1_500; // again within two retry-afters: congestion
    l.pause(1_000);
    l.pause(1_000); // same burst: one decrease
    expect(l.capacity()).toBe(4);
    c.t = 2_600;
    l.pause(1_000);
    expect(l.capacity()).toBe(2);
    c.t = 10_000; // long after: a lone one again
    l.pause(1_000);
    expect(l.capacity()).toBe(2);
    const t = { input: 0, output: 0 };
    for (let i = 0; i < 3; i++) l.afterReply(t, { input_tokens: 0, output_tokens: 0 });
    expect(l.capacity()).toBe(3);
    for (let i = 0; i < 200; i++) l.afterReply(t, { input_tokens: 0, output_tokens: 0 });
    expect(l.capacity()).toBe(8);
    expect(l.stats).toMatchObject({ decreases: 2, lowestWindow: 2 });
  });

  it("grants no new slot while in flight is above the window, then resumes as it grows", async () => {
    const { clock } = clockAt();
    const l = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 4, adaptive: true }, clock);
    const held = await Promise.all([0, 1, 2, 3].map(() => l.acquireSlot("run")));
    l.pause(10);
    l.pause(10); // congestion: window 2, 4 in flight
    let granted = 0;
    void l.acquireSlot("run").then(() => granted++);
    held[0].release();
    held[1].release();
    await flush();
    expect(granted).toBe(0); // 2 in flight = window
    held[2].release();
    await flush();
    expect(granted).toBe(1);
  });

  it("does nothing when adaptive is off", () => {
    const l = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 8 });
    l.pause(1_000);
    expect(l.capacity()).toBe(8);
  });
});
