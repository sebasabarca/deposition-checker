// What adjudicating a packet is expected to cost, from measured calls only (DESIGN.md, "Cost model":
// the estimator switches from planning assumptions to measured values once real calls exist). The
// budget never uses this: it reserves the worst case (maxPacketCost), with output at the configured
// max_tokens, which bounds thinking and the verdict together. Actual cost always comes from the
// provider's usage on each recorded call.

import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { callCost, type CallTokens } from "../costs";
import type { Database } from "../db/client";
import { adjudicationRequests, llmCalls, verdicts } from "../db/schema";
import { formatPacket, loadPacket } from "./packet";

export const MIN_MEASURED_CALLS = 4;

export type Measured = {
  calls: number;
  inputTokensPerChar: number; // uncached input tokens per packet character
  promptTokens: number; // the cached system prompt and schema, median
  outputTokens: { median: number; max: number }; // thinking included, as billed
};
export type CallSample = { packetChars: number; input: number; output: number; cacheRead: number; cacheWrite5m: number };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Rates from recorded calls, or null with too few of them to say. Pure.
export function measure(samples: readonly CallSample[]): Measured | null {
  if (samples.length < MIN_MEASURED_CALLS) return null;
  return {
    calls: samples.length,
    inputTokensPerChar: samples.reduce((t, s) => t + s.input, 0) / samples.reduce((t, s) => t + s.packetChars, 0),
    promptTokens: median(samples.map((s) => s.cacheRead + s.cacheWrite5m)),
    outputTokens: { median: median(samples.map((s) => s.output)), max: Math.max(...samples.map((s) => s.output)) },
  };
}

// The expected cost of one packet with a warm cache (the system prompt read from it), at the
// measured median output and at the largest output measured. Pure.
export function expectedPacketCost(model: string, packetChars: number, m: Measured): { median: number; high: number } | null {
  const tokens = (output: number): CallTokens => ({
    input: Math.round(packetChars * m.inputTokensPerChar),
    output,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: m.promptTokens,
  });
  const median = callCost(model, tokens(m.outputTokens.median));
  const high = callCost(model, tokens(m.outputTokens.max));
  return median && high ? { median: median.costUsd, high: high.costUsd } : null;
}

// The extra cost of a cold cache, once per run (or after a 5-minute pause): the prompt written to
// the cache instead of read from it. Pure.
export function coldCacheCost(model: string, m: Measured): number | null {
  const zero = { input: 0, output: 0, cacheWrite1h: 0 };
  const write = callCost(model, { ...zero, cacheWrite5m: m.promptTokens, cacheRead: 0 });
  const read = callCost(model, { ...zero, cacheWrite5m: 0, cacheRead: m.promptTokens });
  return write && read ? write.costUsd - read.costUsd : null;
}

// Samples from every valid or invalid verdict's recorded call for this model and prompt version.
export async function measuredSamples(db: Database, model: string, promptVersion: string): Promise<CallSample[]> {
  const rows = await db
    .select({ candidateId: verdicts.candidateId, input: llmCalls.inputTokens, output: llmCalls.outputTokens, cacheRead: llmCalls.cacheReadTokens, cacheWrite5m: llmCalls.cacheWrite5mTokens })
    .from(verdicts)
    .innerJoin(llmCalls, eq(llmCalls.id, verdicts.llmCallId))
    // A verdict from a reused response (exact-request reuse) points at the call it reused: not a new sample.
    .leftJoin(adjudicationRequests, eq(adjudicationRequests.id, verdicts.requestId))
    .where(and(eq(llmCalls.model, model), eq(verdicts.promptVersion, promptVersion), isNotNull(llmCalls.costUsd), or(isNull(adjudicationRequests.id), ne(adjudicationRequests.status, "reused"))));
  const samples: CallSample[] = [];
  for (const r of rows) samples.push({ ...r, packetChars: formatPacket(await loadPacket(db, r.candidateId)).length });
  return samples;
}
