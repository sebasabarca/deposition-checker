// Public entry point of the jobs module: background ingestion with pg-boss.
// The API queues jobs (enqueueIngest); the worker process runs them (startIngestWorkers).

import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import type { Database } from "../db/client";
import { UPLOADS_DIR } from "../ingest";
import { and, eq, notInArray } from "drizzle-orm";
import { analyses } from "../db/schema";
import { runAnalysis, TERMINAL, type AnalysisDeps } from "./analysis";
import { failureMessage, recordIngestFailure, runIngestJob } from "./ingest";
import { ANALYSIS_FAILED_QUEUE, ANALYSIS_QUEUE, enqueueAnalysis, INGEST_FAILED_QUEUE, INGEST_QUEUE, parseAnalysisJob, parseIngestJob, DISCOVERY_POLL_SECONDS, PARSING_RECHECK_SECONDS } from "./queue";

export { failureMessage, recordIngestFailure, runIngestJob, type IngestJobResult } from "./ingest";
export { analysisCost, candidateSetOf, DIRECT_FABLE, interruptAnalysis, MAX_CONSECUTIVE_FAILURES, paidCallsAllowed, RUNNER_STALE_MS, runAnalysis, TERMINAL, type Analysis, type AnalysisDeps, type AnalysisProgress, type RunOutcome } from "./analysis";
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
