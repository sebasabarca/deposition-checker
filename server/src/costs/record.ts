// Records model calls and adds up what they cost.

import type Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { llmCalls } from "../db/schema";
import { callCost, tokensFromUsage } from "./cost";
import type { Stage } from "./models";

export type RecordedCall = {
  jobId: number | null; // null until analysis jobs exist
  stage: Stage;
  model: string;
  usage: Anthropic.Usage; // the response's usage, as the API returned it
  attempt: number; // 1 for the first try
  items: number; // pairs or exchanges the call carried
  batch?: boolean;
  rawOutput?: string | null; // the response text as received, kept for diagnosis
  effort?: string | null; // the effort setting sent, when the call set one
  latencyMs?: number | null; // from sending the request to receiving the whole response
};

// Writes one llm_calls row for a successful call. Every v2 model call goes through here. A model
// without a price is still recorded, with its tokens and no cost, rather than dropped or counted as free.
export async function recordCall(db: Database, call: RecordedCall) {
  const tokens = tokensFromUsage(call.usage);
  const priced = callCost(call.model, tokens, { batch: call.batch });
  const [row] = await db
    .insert(llmCalls)
    .values({
      jobId: call.jobId,
      stage: call.stage,
      model: call.model,
      items: call.items,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheWrite5mTokens: tokens.cacheWrite5m,
      cacheWrite1hTokens: tokens.cacheWrite1h,
      cacheReadTokens: tokens.cacheRead,
      batch: call.batch ?? false,
      attempt: call.attempt,
      thinkingTokens: call.usage.output_tokens_details?.thinking_tokens ?? null,
      rawOutput: call.rawOutput ?? null,
      effort: call.effort ?? null,
      latencyMs: call.latencyMs ?? null,
      priceVersion: priced?.priceVersion ?? null,
      costUsd: priced?.costUsd ?? null,
    })
    .returning();
  return row;
}

export type JobCost = {
  calls: number;
  unpricedCalls: number;
  pricedUsd: number; // the calls that have a price
  totalUsd: number | null; // null when any call is unpriced: the total is then unknown, not pricedUsd
  byStage: Record<string, { calls: number; unpricedCalls: number; pricedUsd: number }>;
};

// What a job's calls cost, by stage (DESIGN.md: actual cost is the sum of llm_calls.cost_usd).
export async function jobCost(db: Database, jobId: number): Promise<JobCost> {
  const rows = await db
    .select({
      stage: llmCalls.stage,
      calls: sql<number>`count(*)::int`,
      unpricedCalls: sql<number>`(count(*) filter (where ${llmCalls.costUsd} is null))::int`,
      pricedUsd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.jobId, jobId))
    .groupBy(llmCalls.stage);

  const byStage: JobCost["byStage"] = {};
  for (const r of rows) byStage[r.stage] = { calls: r.calls, unpricedCalls: r.unpricedCalls, pricedUsd: Number(r.pricedUsd) };
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const unpricedCalls = rows.reduce((n, r) => n + r.unpricedCalls, 0);
  const pricedUsd = Math.round(rows.reduce((n, r) => n + Number(r.pricedUsd), 0) * 1e8) / 1e8;
  return { calls, unpricedCalls, pricedUsd, totalUsd: unpricedCalls > 0 ? null : pricedUsd, byStage };
}

// The measured ratio of output tokens to everything the model read (uncached input, cache writes and
// reads), over a stage's recorded calls, or null when fewer than `minCalls` exist to measure from.
export async function measuredOutputShare(db: Database, stage: Stage, minCalls = 4): Promise<{ share: number; calls: number } | null> {
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      read: sql<number>`coalesce(sum(${llmCalls.inputTokens} + ${llmCalls.cacheWrite5mTokens} + ${llmCalls.cacheWrite1hTokens} + ${llmCalls.cacheReadTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.stage, stage));
  if (row.calls < minCalls || row.read === 0) return null;
  return { share: row.output / row.read, calls: row.calls };
}
