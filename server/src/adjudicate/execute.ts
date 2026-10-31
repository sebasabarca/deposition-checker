// Runs a set of candidates under a strategy: one candidate per request, at most `maxConcurrency`
// requests in flight.
//
// Paid requests are never retried here. A candidate whose request failed stays without a verdict
// and is counted; only an explicit resume sends it again. Budget, verification and scoring are the
// existing ones: each request reserves its worst case atomically before it is sent, and every verdict
// goes through storeVerdict() and assess().

import { BudgetExceeded } from "../costs";
import type { Database } from "../db/client";
import { timed } from "../timing";
import type { Adjudicator } from "./model";
import { classifyFailure, type RequestContext } from "./requests";
import { adjudicateCandidate } from "./run";
import { runPool, type PoolControl, type PoolStep } from "./pool";
import { STRATEGIES, type StrategyId } from "./strategies";

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
  single: Adjudicator;
  signal?: AbortSignal; // the process is shutting down
  shouldStop?: () => Promise<string | null>; // checked on start and every STOP_CHECK_MS
  allowRepeat?: boolean; // an explicit retry of candidates that already have an invalid verdict
  maxConsecutiveFailures?: number;
  onProgress?: (counts: ExecutionCounts) => Promise<void>;
};

export async function executeAdjudication(db: Database, input: ExecutionInput): Promise<ExecutionResult> {
  const { candidateSet, analysisId = null, strategy, budgetId, single, signal, shouldStop, allowRepeat = false, maxConsecutiveFailures = 3, onProgress } = input;
  const config = STRATEGIES[strategy];

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
      await timed("adjudicate.live_candidate", () => adjudicateCandidate(db, candidateId, single, { budgetId, allowRepeat, request: context }), { analysisId });
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
    const result = await runPool(input.candidateIds, pool, runSingle, take);
    return { ...counts, stopped: result.stopped, peak: result.peak, unstarted: result.unstarted.length, lastError };
  } finally {
    if (ticker) clearInterval(ticker);
    signal?.removeEventListener("abort", onShutdown);
  }
}
