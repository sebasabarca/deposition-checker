// What the worker does with an ingest job, and with one that failed every attempt.
//
// A job may run more than once: pg-boss retries a failed attempt, and redelivers a job whose worker
// finished it but crashed before telling pg-boss. Both handlers are safe to repeat, and both act
// only on the run they were queued for (the deposition's ingest_run):
// - runIngestJob does nothing unless the deposition is still processing that run, and
//   saveDeposition replaces rows rather than adding them.
// - recordIngestFailure only changes a deposition still processing that run, so a failure can never
//   overwrite a finished deposition (above all a ready one), or a newer retry.

import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { depositions } from "../db/schema";
import { depositionLockKey, PARSER_VERSION, readDeposition, readUpload, saveDeposition, UPLOADS_DIR, type SaveResult } from "../ingest";
import type { IngestJob } from "./queue";

const MAX_ERROR_LENGTH = 2000;

export type IngestJobResult = { outcome: "skipped"; status: string | null } | SaveResult;

type Deposition = typeof depositions.$inferSelect;

// The deposition is processing the job's run: the condition every write below repeats.
const isCurrentRun = (job: IngestJob) =>
  and(eq(depositions.id, job.depositionId), eq(depositions.status, "processing"), eq(depositions.ingestRun, job.run));

// Reads the stored file and saves the result into the queued deposition. An unreadable or invalid
// PDF is not an error here: readDeposition reports it, and it is saved as unsupported or
// needs_review. Anything this throws is a system failure (a missing or damaged stored file, a
// database error, a bug), which pg-boss retries.
export async function runIngestJob(db: Database, job: IngestJob, uploadsDir = UPLOADS_DIR): Promise<IngestJobResult> {
  const [deposition] = await db.select().from(depositions).where(eq(depositions.id, job.depositionId));
  if (!deposition || deposition.status !== "processing" || deposition.ingestRun !== job.run) {
    return { outcome: "skipped", status: deposition?.status ?? null };
  }
  if (deposition.parserVersion !== PARSER_VERSION) {
    const adopted = await adoptParserVersion(db, deposition, job);
    if (adopted !== "adopted") return { outcome: "skipped", status: adopted };
  }

  const data = await readUpload(deposition.storageKey, uploadsDir);
  const read = await readDeposition(data);
  // The run is checked again inside the save, under its lock: parsing takes time, and meanwhile this
  // attempt may have been given up on (marked failed, then retried as a newer run). saveDeposition
  // throws if the result would land on another deposition, so a job never succeeds while leaving its
  // deposition processing.
  const saved = await saveDeposition(
    db,
    {
      caseId: deposition.caseId,
      witnessId: deposition.witnessId,
      takenOn: deposition.takenOn,
      fileSha256: deposition.fileSha256,
      storageKey: deposition.storageKey,
      read,
    },
    job,
  );
  return saved.outcome === "not_current" ? { outcome: "skipped", status: saved.status } : saved;
}

// The deposition was queued for another parser version than the one this worker runs (the parser
// changed between upload and processing). A processing deposition has no lines yet, so its version
// only says which parser was expected: it takes this worker's version and is ingested as usual.
// If another deposition already stores the file under this version, this one is a duplicate, so it
// is marked failed with a pointer to the existing one rather than left processing. Overlapping
// attempts may both get here with the old version; the second then finds this same deposition
// already adopted, which is not a duplicate.
export async function adoptParserVersion(db: Database, deposition: Deposition, job: IngestJob): Promise<"adopted" | "failed" | "skipped"> {
  return db.transaction(async (tx) => {
    const lockKey = depositionLockKey(deposition.caseId, deposition.fileSha256, PARSER_VERSION);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const [existing] = await tx
      .select({ id: depositions.id })
      .from(depositions)
      .where(
        and(
          eq(depositions.caseId, deposition.caseId),
          eq(depositions.fileSha256, deposition.fileSha256),
          eq(depositions.parserVersion, PARSER_VERSION),
          ne(depositions.id, deposition.id),
        ),
      );
    const changes = existing
      ? {
          status: "failed" as const,
          ingestError: `This file is already stored as deposition ${existing.id}, read by the current parser (${PARSER_VERSION}); this deposition was queued for ${deposition.parserVersion}.`,
        }
      : { parserVersion: PARSER_VERSION };
    const updated = await tx.update(depositions).set(changes).where(isCurrentRun(job)).returning({ id: depositions.id });
    if (updated.length === 0) return "skipped"; // finished or retried meanwhile
    return existing ? "failed" : "adopted";
  });
}

// Marks a deposition failed after the last attempt of `job`. Returns false when the deposition is no
// longer processing that run (it finished, or a newer retry is under way), in which case nothing changes.
export async function recordIngestFailure(db: Database, job: IngestJob, message: string): Promise<boolean> {
  const updated = await db
    .update(depositions)
    .set({ status: "failed", ingestError: message.slice(0, MAX_ERROR_LENGTH) })
    .where(isCurrentRun(job))
    .returning({ id: depositions.id });
  return updated.length > 0;
}

// The error pg-boss stored for the failed job's last attempt, as a sentence for the deposition.
export function failureMessage(output: unknown): string {
  const detail =
    typeof output === "string"
      ? output
      : output && typeof output === "object" && typeof (output as { message?: unknown }).message === "string"
        ? (output as { message: string }).message
        : null;
  return `Ingestion failed after every attempt: ${detail ?? "no error was recorded"}`;
}
