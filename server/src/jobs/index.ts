// Public entry point of the jobs module: background ingestion with pg-boss.
// The API queues jobs (enqueueIngest); the worker process runs them (startIngestWorkers).

import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import type { Database } from "../db/client";
import { UPLOADS_DIR } from "../ingest";
import { and, eq, notInArray } from "drizzle-orm";
import type { Pool } from "pg";
import { analyses, caseRuns } from "../db/schema";
import { CASE_RUN_TERMINAL, runCaseRun, type CaseRunDeps } from "./caseRun";
import { BATCH_DEFAULTS, batchRunsToResume, MOCK_POLL_SECONDS } from "./caseRunBatch";
import { runAnalysis, TERMINAL, type AnalysisDeps } from "./analysis";
import { failureMessage, recordIngestFailure, runIngestJob } from "./ingest";
import { CASE_RUN_FAILED_QUEUE, CASE_RUN_QUEUE, enqueueCaseRun, parseCaseRunJob, ANALYSIS_FAILED_QUEUE, ANALYSIS_QUEUE, enqueueAnalysis, INGEST_FAILED_QUEUE, INGEST_QUEUE, parseAnalysisJob, parseIngestJob, DISCOVERY_POLL_SECONDS, PARSING_RECHECK_SECONDS } from "./queue";

export { failureMessage, recordIngestFailure, runIngestJob, type IngestJobResult } from "./ingest";
export { analysisCost, candidateSetOf, DIRECT_FABLE, interruptAnalysis, MAX_CONSECUTIVE_FAILURES, paidCallsAllowed, RUNNER_STALE_MS, runAnalysis, TERMINAL, type Analysis, type AnalysisDeps, type AnalysisProgress, type RunOutcome } from "./analysis";
export { CASE_RUN_TERMINAL, caseRunFindings, caseRunReport, caseRunSetOf, createCaseRun, fromPacketAdjudicator, mockCaseModel, resumeCaseRun, runCaseRun, type CaseRunDeps } from "./caseRun";
export { CASE_RUN_QUEUE, createCaseRunQueues, enqueueCaseRun } from "./queue";
export { batchSettings, BATCH_DEFAULTS, runBatchTick, type BatchDeps, type BatchSettings } from "./caseRunBatch";
export {
  ANALYSIS_FAILED_QUEUE,
  ANALYSIS_QUEUE,
  createAnalysisQueues,
  enqueueAnalysis,
  parseAnalysisJob,
  createIngestQueues,
  enqueueIngest,
  INGEST_FAILED_QUEUE,
  INGEST_FAILED_QUEUE_OPTIONS,
  INGEST_QUEUE,
  INGEST_QUEUE_OPTIONS,
  parseIngestJob,
  startBoss,
  type IngestJob,
} from "./queue";

export type WorkerOptions = { uploadsDir?: string; pollingIntervalSeconds?: number };

// Starts the two workers. A handler that throws fails the attempt, and pg-boss retries it.
export async function startIngestWorkers(boss: PgBoss, db: Database, options: WorkerOptions = {}): Promise<void> {
  const { uploadsDir = UPLOADS_DIR, pollingIntervalSeconds = 2 } = options;

  await boss.work(INGEST_QUEUE, { pollingIntervalSeconds }, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const data = parseIngestJob(job.data);
      const result = await runIngestJob(db, data, uploadsDir);
      console.log(`ingest: deposition ${data.depositionId} ${result.outcome === "skipped" ? `skipped (${result.status})` : result.status}`);
    }
  });

  await boss.work(INGEST_FAILED_QUEUE, { pollingIntervalSeconds, includeMetadata: true }, async (jobs: JobWithMetadata<unknown>[]) => {
    for (const job of jobs) {
      const data = parseIngestJob(job.data);
      const recorded = await recordIngestFailure(db, data, failureMessage(job.sourceOutput));
      console.log(`ingest: deposition ${data.depositionId} ${recorded ? "marked failed" : "finished or retried since; failure not recorded"}`);
    }
  });
}

// The analysis workers. A job whose depositions are still being read is queued again after a short
// wait (bounded by runAnalysis); every other outcome is recorded on the analysis itself.
export async function startAnalysisWorkers(boss: PgBoss, db: Database, deps: AnalysisDeps, { pollingIntervalSeconds = 2 } = {}): Promise<void> {
  await boss.work(ANALYSIS_QUEUE, { pollingIntervalSeconds }, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const { analysisId } = parseAnalysisJob(job.data);
      const outcome = await runAnalysis(db, analysisId, deps);
      if (outcome === "waiting") await enqueueAnalysis(boss, { analysisId }, { startAfterSeconds: PARSING_RECHECK_SECONDS });
      if (outcome === "polling") await enqueueAnalysis(boss, { analysisId }, { startAfterSeconds: DISCOVERY_POLL_SECONDS });
      console.log(`analysis ${analysisId}: ${outcome}`);
    }
  });
  await boss.work(ANALYSIS_FAILED_QUEUE, { pollingIntervalSeconds, includeMetadata: true }, async (jobs: JobWithMetadata<unknown>[]) => {
    for (const job of jobs) {
      const { analysisId } = parseAnalysisJob(job.data);
      await db
        .update(analyses)
        .set({ status: "failed", error: `The analysis job failed after every attempt: ${failureMessage(job.sourceOutput).replace(/^Ingestion failed after every attempt: /, "")}`.slice(0, 2000), finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(analyses.id, analysisId), notInArray(analyses.status, TERMINAL)));
    }
  });
}

// The case-run workers. A run that stops for any reason records it on its row; only a thrown error
// (database, bug) is retried by pg-boss and, after the last attempt, marked failed here.
// maxCases runs execute at once in this process; their packets share deps.limiter (jobs/limiter.ts).
// An economy run's tick returns "polling" while its batches are open: the job queues its next check, mock runs
// sooner (MOCK_POLL_SECONDS). On start, every economy run still adjudicating is queued again, in case a follow-up
// job was lost (the singleton key keeps a run from being queued twice).
export async function startCaseRunWorkers(boss: PgBoss, db: Database, pool: Pool, deps: CaseRunDeps, { pollingIntervalSeconds = 2, maxCases = 1, batchPollSeconds = BATCH_DEFAULTS.pollSeconds } = {}): Promise<void> {
  await boss.work(CASE_RUN_QUEUE, { pollingIntervalSeconds, localConcurrency: maxCases }, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const { caseRunId } = parseCaseRunJob(job.data);
      const outcome = await runCaseRun(db, pool, caseRunId, deps);
      if (outcome === "polling") {
        const [run] = await db.select({ mode: caseRuns.mode }).from(caseRuns).where(eq(caseRuns.id, caseRunId));
        await enqueueCaseRun(boss, { caseRunId }, { startAfterSeconds: run?.mode === "mock" ? MOCK_POLL_SECONDS : batchPollSeconds });
      } else console.log(`case run ${caseRunId}: ${outcome}`);
    }
  });
  for (const r of await batchRunsToResume(db)) await enqueueCaseRun(boss, { caseRunId: r.id });
  await boss.work(CASE_RUN_FAILED_QUEUE, { pollingIntervalSeconds, includeMetadata: true }, async (jobs: JobWithMetadata<unknown>[]) => {
    for (const job of jobs) {
      const { caseRunId } = parseCaseRunJob(job.data);
      await db
        .update(caseRuns)
        .set({ status: "failed", error: `The case-run job failed after every attempt: ${failureMessage(job.sourceOutput).replace(/^Ingestion failed after every attempt: /, "")}`.slice(0, 2000), finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(caseRuns.id, caseRunId), notInArray(caseRuns.status, CASE_RUN_TERMINAL)));
    }
  });
}
