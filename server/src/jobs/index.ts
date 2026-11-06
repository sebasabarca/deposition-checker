// Public entry point of the jobs module: background ingestion and whole-case runs with pg-boss.
// The API queues jobs (enqueueIngest, enqueueCaseRun); the worker process runs them.

import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import type { Database } from "../db/client";
import { UPLOADS_DIR } from "../ingest";
import { and, eq, notInArray } from "drizzle-orm";
import type { Pool } from "pg";
import { caseRuns } from "../db/schema";
import { CASE_RUN_TERMINAL, orphanedCaseRuns, runCaseRun, type CaseRunDeps } from "./caseRun";
import { BATCH_DEFAULTS, batchRunsToResume, MOCK_POLL_SECONDS } from "./caseRunBatch";
import { failureMessage, recordIngestFailure, runIngestJob } from "./ingest";
import { CASE_RUN_FAILED_QUEUE, CASE_RUN_QUEUE, enqueueCaseRun, parseCaseRunJob, INGEST_FAILED_QUEUE, INGEST_QUEUE, parseIngestJob } from "./queue";

export { failureMessage, recordIngestFailure, runIngestJob, type IngestJobResult } from "./ingest";
export { analysisKeySet, paidCallsAllowed } from "./paid";
export { CASE_RUN_TERMINAL, caseRunFindings, caseRunReport, caseRunSetOf, contractOf, createCaseRun, fromPacketAdjudicator, stretchAllowed, mockCaseModel, resumeCaseRun, runCaseRun, type CaseRunDeps } from "./caseRun";
export { CASE_RUN_QUEUE, createCaseRunQueues, enqueueCaseRun } from "./queue";
export { batchSettings, BATCH_DEFAULTS, runBatchTick, type BatchDeps, type BatchSettings } from "./caseRunBatch";
export {
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

// The case-run workers. A run that stops for any reason records it on its row; only a thrown error
// (database, bug) is retried by pg-boss and, after the last attempt, marked failed here.
// maxCases runs execute at once in this process; their packets share deps.limiter (jobs/limiter.ts).
// An economy run's tick returns "polling" while its batches are open: the job queues its next check, mock runs
// sooner (MOCK_POLL_SECONDS). On start, every economy run still adjudicating is queued again, in case a follow-up
// job was lost (the singleton key keeps a run from being queued twice).
const ORPHAN_SWEEP_MS = 5 * 60_000;

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
  // Runs no worker holds (their job was lost) go back to the queue, now and every few minutes (caseRun.ts).
  const sweep = async () => { for (const id of await orphanedCaseRuns(db)) { console.log(`case run ${id}: no worker held it; queued again`); await enqueueCaseRun(boss, { caseRunId: id }); } };
  await sweep();
  const timer = setInterval(() => void sweep().catch((e) => console.error(`Case-run sweep failed: ${e instanceof Error ? e.message : e}`)), ORPHAN_SWEEP_MS);
  timer.unref();
  deps.signal?.addEventListener("abort", () => clearInterval(timer));
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
