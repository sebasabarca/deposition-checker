// Public entry point of the jobs module: background ingestion with pg-boss.
// The API queues jobs (enqueueIngest); the worker process runs them (startIngestWorkers).

import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import type { Database } from "../db/client";
import { UPLOADS_DIR } from "../ingest";
import { failureMessage, recordIngestFailure, runIngestJob } from "./ingest";
import { INGEST_FAILED_QUEUE, INGEST_QUEUE, parseIngestJob } from "./queue";

export { failureMessage, recordIngestFailure, runIngestJob, type IngestJobResult } from "./ingest";
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
