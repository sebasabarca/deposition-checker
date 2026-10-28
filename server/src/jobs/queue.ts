// The pg-boss queues for ingestion. pg-boss keeps its jobs in Postgres (its own `pgboss` schema),
// so a queued job survives restarts of the API and the worker, and no other service is needed.

import { PgBoss, type QueueOptions } from "pg-boss";
import type { PoolClient } from "pg";
import { z } from "zod";

export const INGEST_QUEUE = "ingest-deposition";
// Where pg-boss moves an ingest job after its last attempt fails; its worker records the failure.
export const INGEST_FAILED_QUEUE = "ingest-deposition-failed";

// `run` is the deposition's ingest_run when the job was queued (see the schema). Jobs queued before
// runs existed (migration 0003) have no `run`; they belong to run 1, the run 0003 gave every existing
// deposition, so a missing run is read as 1 rather than left to match nothing.
const IngestJobData = z.object({
  depositionId: z.number().int().positive(),
  run: z.number().int().positive().default(1),
});
export type IngestJob = z.infer<typeof IngestJobData>;

// A job's payload as the worker receives it, checked like any data from outside the process. A
// payload that doesn't parse throws, so the job fails visibly instead of being skipped.
export function parseIngestJob(data: unknown): IngestJob {
  return IngestJobData.parse(data);
}

// DESIGN.md: 3 attempts with exponential backoff. The heartbeat lets pg-boss notice a worker that
// crashed mid-job within about 30 seconds and retry the job, instead of waiting for it to expire.
export const INGEST_QUEUE_OPTIONS: QueueOptions = {
  retryLimit: 2,
  retryDelay: 10,
  retryBackoff: true,
  heartbeatSeconds: 30,
  expireInSeconds: 15 * 60,
};

// Recording a failure must outlast a database outage, so it retries far longer: the delay doubles
// from 10 seconds up to 10 minutes, about 3 hours over 20 attempts.
export const INGEST_FAILED_QUEUE_OPTIONS: QueueOptions = {
  retryLimit: 20,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 10 * 60,
};

// The API only queues jobs, so it leaves maintenance (expiring jobs, moving failed ones to the dead
// letter queue) to the worker by passing supervise: false.
export async function startBoss(connectionString: string, { supervise }: { supervise: boolean }): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, supervise, schedule: false });
  boss.on("error", (error) => console.error("pg-boss:", error));
  await boss.start();
  return boss;
}

// Creates the two queues, or brings their settings up to date. Safe to run on every start.
// `overrides` lets tests use short retry delays.
export async function createIngestQueues(boss: PgBoss, overrides: QueueOptions = {}): Promise<void> {
  const ensure = async (name: string, options: QueueOptions & { deadLetter?: string }) => {
    if (await boss.getQueue(name)) await boss.updateQueue(name, options);
    else await boss.createQueue(name, options);
  };
  await ensure(INGEST_FAILED_QUEUE, { ...INGEST_FAILED_QUEUE_OPTIONS, ...overrides });
  await ensure(INGEST_QUEUE, { ...INGEST_QUEUE_OPTIONS, ...overrides, deadLetter: INGEST_FAILED_QUEUE });
}

// Queues ingestion of a deposition inside the caller's transaction (on `client`), so the deposition
// row and its job are committed together: never a row without a job, or a job without a row.
export async function enqueueIngest(boss: PgBoss, client: PoolClient, job: IngestJob): Promise<void> {
  await boss.send(INGEST_QUEUE, job, { db: { executeSql: (text, values) => client.query(text, values) } });
}
