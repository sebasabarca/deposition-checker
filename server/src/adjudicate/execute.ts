// Runs a set of candidates under a strategy: one candidate or a batch per request, at most
// `maxConcurrency` requests in flight. Used by analysis jobs and by the strategy experiments.
//
// Paid requests are never retried here. A candidate whose request failed stays without a verdict
// and is counted; only an explicit resume sends it again. Budget, verification and scoring are the
// existing ones: each request reserves its worst case atomically before it is sent, and every verdict
// goes through storeVerdict() and assess().

import { and, eq, inArray } from "drizzle-orm";
import { BudgetExceeded, closeFailed, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { verdicts } from "../db/schema";
import { timed } from "../timing";
import { BATCH_LIMITS, BATCH_PROMPT_VERSION, batchOutputTokens, estimateBatchInputTokens, planBatches, readBatch, type BatchLimits, type PlannedBatch } from "./batch";
import type { Adjudicator, BatchAdjudicator } from "./model";
import { loadPacket, type Packet } from "./packet";
import { classifyFailure, closeRequest, openRequest, type RequestContext } from "./requests";
import { adjudicateCandidate, storeVerdict } from "./run";
import { runPool, type PoolControl, type PoolStep } from "./pool";
import { STRATEGIES, usesBatchFormat, type StrategyId } from "./strategies";

export const STOP_CHECK_MS = 1000;

export type ExecutionCounts = { adjudicated: number; failed: number; rateLimited: number; oversize: number; requests: number };
export type ExecutionResult = ExecutionCounts & { stopped: string | null; peak: number; unstarted: number; lastError: string | null };

export type ExecutionInput = {
  candidateSet: string;
  analysisId?: number | null;
  candidateIds: number[]; // in rank order
  strategy: StrategyId;
  maxConcurrency?: number; // overrides the strategy's own limit
  budgetId: number;
  single?: Adjudicator;
  batch?: BatchAdjudicator;
  signal?: AbortSignal; // the process is shutting down
  shouldStop?: () => Promise<string | null>; // checked on start and every STOP_CHECK_MS
  allowRepeat?: boolean; // an explicit retry of candidates that already have an invalid verdict
  maxConsecutiveFailures?: number;
  onProgress?: (counts: ExecutionCounts) => Promise<void>;
  limits?: BatchLimits;
};

export async function executeAdjudication(db: Database, input: ExecutionInput): Promise<ExecutionResult> {
  const { candidateSet, analysisId = null, strategy, budgetId, single, batch, signal, shouldStop, allowRepeat = false, maxConsecutiveFailures = 3, onProgress, limits = BATCH_LIMITS } = input;
  const config = STRATEGIES[strategy];
  const batched = usesBatchFormat(strategy);
  if (batched ? !batch : !single) throw new Error(`Strategy ${strategy} needs a ${batched ? "batch" : "single"} adjudicator.`);

  const abort = new AbortController();
  const maxConcurrency = input.maxConcurrency ?? config.maxConcurrency;
  const context: RequestContext = { candidateSet, analysisId, strategy, maxConcurrency, signal: abort.signal };
  const counts: ExecutionCounts = { adjudicated: 0, failed: 0, rateLimited: 0, oversize: 0, requests: 0 };
  let consecutive = 0;
  let lastError: string | null = null;
  let control: PoolControl | null = null;
  const stop = (reason: string) => {
    control?.stop(reason);
    abort.abort();
  };

  // A model failure doesn't throw out of the pool: it is counted and decides what happens next.
  const failureStep = (error: unknown, candidates: number): PoolStep => {
    if (error instanceof BudgetExceeded) return { requeue: "budget" };
    const failure = classifyFailure(error);
    if (failure.kind === "aborted") return {};
    counts.failed += candidates;
    lastError = error instanceof Error ? error.message : String(error);
    if (failure.retryAfterMs !== null) counts.rateLimited++;
    consecutive++;
    return { pauseMs: failure.retryAfterMs ?? undefined, stop: consecutive >= maxConsecutiveFailures ? "failures" : undefined };
  };
  const report = () => onProgress?.(counts);

  const runSingle = async (candidateId: number): Promise<PoolStep> => {
    try {
      await timed("adjudicate.live_candidate", () => adjudicateCandidate(db, candidateId, single!, { budgetId, allowRepeat, request: context }), { analysisId });
      counts.requests++;
      counts.adjudicated++;
      consecutive = 0;
      await report();
      return {};
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) counts.requests++;
      const step = failureStep(error, 1);
      await report();
      return step;
    }
  };

  const runBatch = async (planned: PlannedBatch): Promise<PoolStep> => {
    const { packets, text, splitReason } = planned;
    const adjudicator = batch!;
    const candidateIds = packets.map((p) => p.candidateId);
    const maxOutputTokens = batchOutputTokens(packets.length, limits);
    const maxCostUsd = maxRequestCost(adjudicator.model, { inputTokens: inputTokenBound(adjudicator.promptChars + text.length), maxOutputTokens });
    let reservation: number;
    try {
      reservation = await reserve(db, budgetId, maxCostUsd, `adjudication ${BATCH_PROMPT_VERSION} ${packets.length} candidates`);
    } catch (error) {
      return failureStep(error, packets.length);
    }
    const requestId = await openRequest(db, context, { candidateIds, model: adjudicator.model, promptVersion: BATCH_PROMPT_VERSION, estimatedInputTokens: estimateBatchInputTokens(text, limits), maxOutputTokens, maxCostUsd, reservationId: reservation, splitReason });
    counts.requests++;
    let reply;
    try {
      reply = await timed("adjudicate.api_call", () => adjudicator.adjudicate(text, maxOutputTokens, { signal: abort.signal }), { candidates: packets.length });
    } catch (error) {
      await closeFailed(db, reservation, error);
      const failure = classifyFailure(error);
      await closeRequest(db, requestId, { status: failure.status, errorKind: failure.kind, error: String(error instanceof Error ? error.message : error).slice(0, 2000), retryAfterMs: failure.retryAfterMs, missingCandidateIds: candidateIds });
      const step = failureStep(error, packets.length);
      await report();
      return step;
    }
    // One charge for the whole request, recorded once, however many candidates it carried.
    const call = await recordCall(db, { jobId: analysisId, stage: "adjudication", model: adjudicator.model, usage: reply.usage, attempt: 1, items: packets.length, rawOutput: reply.text, effort: adjudicator.effort, latencyMs: reply.latencyMs });
    await settle(db, reservation, call);

    const reading = readBatch(packets, reply.stopReason, reply.text);
    const base = { model: reply.model, promptVersion: BATCH_PROMPT_VERSION, effort: adjudicator.effort, origin: "model" as const, llmCallId: call.id, requestId };
    for (const a of reading.accepted) await storeVerdict(db, { ...base, candidateId: a.packet.candidateId, packet: a.packet, read: { status: "valid", parsed: a.verdict, error: null }, raw: a.raw });
    for (const r of reading.rejected) await storeVerdict(db, { ...base, candidateId: r.packet.candidateId, packet: r.packet, read: { status: "schema_invalid", parsed: null, error: r.reason }, raw: r.raw });

    const answered = reading.accepted.length + reading.rejected.length;
    const unanswered = reading.missing.length + reading.duplicates.length;
    const none = reading.accepted.length === 0;
    await closeRequest(db, requestId, {
      status: none ? "failed" : unanswered + reading.rejected.length > 0 ? "partial" : "completed",
      providerRequestId: reply.requestId ?? null,
      llmCallId: call.id,
      latencyMs: reply.latencyMs,
      errorKind: reading.unusable ? (reply.stopReason === "max_tokens" ? "cut_off" : reply.stopReason === "refusal" ? "refused" : "unparseable") : null,
      error: reading.unusable,
      missingCandidateIds: reading.missing,
      duplicateCandidateIds: reading.duplicates,
      unknownCandidateIds: reading.unknown,
      contaminatedCandidateIds: reading.rejected.filter((r) => r.kind === "contaminated").map((r) => r.packet.candidateId),
      suspectedCandidateIds: reading.accepted.filter((a) => a.suspected.length > 0).map((a) => a.packet.candidateId),
    });
    counts.adjudicated += answered;
    counts.failed += unanswered;
    if (reading.unusable) lastError = reading.unusable;
    consecutive = none ? consecutive + 1 : 0;
    await report();
    return { stop: consecutive >= maxConsecutiveFailures ? "failures" : undefined };
  };

  const onShutdown = () => stop("shutdown");
  if (signal?.aborted) return { ...counts, stopped: "shutdown", peak: 0, unstarted: input.candidateIds.length, lastError };
  const before = await shouldStop?.();
  if (before) return { ...counts, stopped: before, peak: 0, unstarted: input.candidateIds.length, lastError };
  signal?.addEventListener("abort", onShutdown, { once: true });
  let checking = false;
  const ticker = shouldStop
    ? setInterval(() => {
        if (checking) return;
        checking = true;
        void shouldStop()
          .then((reason) => {
            if (reason) stop(reason);
          })
          .finally(() => {
            checking = false;
          });
      }, STOP_CHECK_MS)
    : null;

  try {
    const pool = { concurrency: maxConcurrency, warmFirst: maxConcurrency > 1 };
    const take = (c: PoolControl) => {
      control = c;
    };
    if (!batched) {
      const result = await runPool(input.candidateIds, pool, runSingle, take);
      return { ...counts, stopped: result.stopped, peak: result.peak, unstarted: result.unstarted.length, lastError };
    }
    // Candidates that already have this prompt's verdict are never sent again, unless asked for.
    const done = allowRepeat
      ? new Set<number>()
      : new Set(
          input.candidateIds.length
            ? (await db.select({ id: verdicts.candidateId }).from(verdicts).where(and(inArray(verdicts.candidateId, input.candidateIds), eq(verdicts.promptVersion, BATCH_PROMPT_VERSION)))).map((r) => r.id)
            : [],
        );
    const packets: Packet[] = [];
    for (const id of input.candidateIds) if (!done.has(id)) packets.push(await loadPacket(db, id));
    const plan = planBatches(packets, config.candidatesPerRequest, limits);
    for (const { packet, reason } of plan.oversize) {
      counts.oversize++;
      counts.failed++;
      await openRequest(db, context, { candidateIds: [packet.candidateId], model: batch!.model, promptVersion: BATCH_PROMPT_VERSION, estimatedInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0, reservationId: null, status: "oversize", errorKind: "oversize", error: reason });
    }
    const result = await runPool(plan.batches, pool, runBatch, take);
    return { ...counts, stopped: result.stopped, peak: result.peak, unstarted: result.unstarted.reduce((n, b) => n + b.packets.length, 0), lastError };
  } finally {
    if (ticker) clearInterval(ticker);
    signal?.removeEventListener("abort", onShutdown);
  }
}
