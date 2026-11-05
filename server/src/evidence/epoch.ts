// Evidence versions for the results a job derives from a deposition. No model call.
//
// depositions.evidence_epoch counts committed corrections and rollbacks of a document's evidence. A job (an
// analysis, a case run, a fact extraction) records the epochs of the depositions it reads before it first reads
// them, keeps them on its own row across resumes, and writes every result through a connection that declares
// them (evidence.read_epochs). Migration 0039's guard then checks, in the same statement and under the same
// key-share lock a correction must wait for, that each declared epoch is still current, and refuses the write
// (SQLSTATE VE002) otherwise: a result computed from evidence that has since been corrected never becomes current,
// whenever it arrives, before, during or after the correction's hold.

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Database } from "../db/client";
import * as schema from "../db/schema";
import { depositions } from "../db/schema";

export const STALE_EVIDENCE = "VE002";
export type Epochs = Record<string, number>; // deposition ID -> evidence_epoch read

const hasCode = (e: unknown, code: string) => {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) if (x.code === code) return true;
  return false;
};
// The database refused a result computed from evidence that has changed since (or from a deposition the job never read).
export const isStaleEvidence = (e: unknown) => hasCode(e, STALE_EVIDENCE);

export async function captureEpochs(db: Database, ids: readonly number[]): Promise<Epochs> {
  if (!ids.length) return {};
  const rows = await db.select({ id: depositions.id, epoch: depositions.evidenceEpoch }).from(depositions).where(inArray(depositions.id, [...new Set(ids)]));
  return Object.fromEntries(rows.map((r) => [String(r.id), r.epoch]));
}

// Runs fn with a database whose every connection declares these epochs, so every write it makes is checked.
// The connections are its own (a small pool, closed afterwards): a declaration never leaks to other work.
export async function withEvidenceFence<T>(db: Database, epochs: Epochs, fn: (fenced: Database) => Promise<T>): Promise<T> {
  const base = (db as unknown as { $client: pg.Pool }).$client;
  if (!(base instanceof pg.Pool)) throw new Error("withEvidenceFence needs a pool-backed database, not a transaction.");
  const pool = new pg.Pool({ ...base.options, max: 4 });
  const declared = JSON.stringify(epochs);
  pool.on("connect", (client) => { client.query("select set_config('evidence.read_epochs', $1, false)", [declared]).catch(() => undefined); });
  try {
    return await fn(drizzle(pool, { schema }) as unknown as Database);
  } finally {
    await pool.end();
  }
}

// The epochs a job reads: those it recorded when it first read its depositions, or the current ones, recorded now.
export async function jobEpochs(db: Database, table: "analyses" | "case_runs", id: number, stored: unknown, depositionIds: readonly number[]): Promise<Epochs> {
  if (stored && typeof stored === "object" && Object.keys(stored).length) return stored as Epochs;
  const epochs = await captureEpochs(db, depositionIds);
  await db.execute(sql`update ${sql.identifier(table)} set source_epochs = ${JSON.stringify(epochs)}::jsonb where id = ${id} and source_epochs is null`);
  const [r] = (await db.execute(sql`select source_epochs from ${sql.identifier(table)} where id = ${id}`)).rows as { source_epochs: Epochs }[];
  return r.source_epochs; // another delivery may have recorded them first: theirs stand
}

// One write transaction declaring the epochs a result was computed from (a packet's, an extraction's), unless the
// connection already declares a job's: those were read earlier, so they stand.
export async function fencedTransaction<T>(db: Database, epochs: Epochs | undefined, fn: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    const declares = epochs && Object.keys(epochs).length ? (await tx.execute(sql`select set_config('evidence.read_epochs', ${JSON.stringify(epochs)}, true) as set where coalesce(current_setting('evidence.read_epochs', true), '') = ''`)).rows.length > 0 : false;
    const out = await fn(tx);
    // Nested in a caller's transaction (a savepoint), a local setting would outlive this one: clear it.
    if (declares) await tx.execute(sql`select set_config('evidence.read_epochs', '', true)`);
    return out;
  });
}
