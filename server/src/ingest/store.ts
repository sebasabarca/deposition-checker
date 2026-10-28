// Saves a read deposition to Postgres in one transaction (DESIGN.md, Ingestion step 4).
// A deposition is keyed by case, file hash and parser version. Saving the same key again keeps the
// deposition row and its ID, and replaces its lines and exchanges, so a retry never duplicates
// source records. If anything fails, the transaction rolls back and the previous rows stay as they were.
//
// Two rules protect stored evidence:
// - A ready deposition is never replaced by an attempt that isn't ready (a parse that failed this
//   time). Its rows and status stay, and the failed attempt's validation is returned to the caller.
// - Saves of the same key run one at a time, under a transaction-level advisory lock, so two
//   processes ingesting the same file can't both decide the deposition is new.
// The worker also passes the run it is saving for (`onlyIf`): the save then happens only if that
// deposition is still processing that run, checked with its row locked inside this transaction.

import { and, countDistinct, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { depositions, exchangeLines, exchanges, lines } from "../db/schema";
import type { DepositionRead } from "./index";
import type { DepositionStatus, Validation } from "./validate";
import { lineIdsByPosition, toExchangeLineRows, toExchangeRows, toLineRows } from "./rows";

// Rows per INSERT, keeping each statement well under Postgres's 65,535 parameter limit.
const BATCH_SIZE = 1000;

export type SaveInput = {
  caseId: number;
  witnessId: number;
  takenOn: string | null; // YYYY-MM-DD, or null when the transcript doesn't state it
  fileSha256: string;
  storageKey: string;
  read: DepositionRead;
};

export type SaveOutcome =
  | "created" // first ingestion of this file and parser version in the case
  | "replaced" // ingested before; its rows were replaced by this attempt's
  | "kept_previous"; // ingested before as ready, and this attempt wasn't ready: nothing was changed

export type SaveResult = {
  depositionId: number;
  outcome: SaveOutcome;
  status: DepositionStatus; // the stored deposition's status after the save
  lines: number; // what is stored for the deposition after the save
  exchanges: number; // whole exchanges; a long answer split into parts counts once
  parts: number;
  attempt: Validation; // this attempt's validation, also when it was not stored
};

// The ingestion run a worker's save is for: the deposition and its ingest_run.
export type CurrentRun = { depositionId: number; run: number };

// Returned instead of saving when the deposition is no longer processing that run: it finished,
// failed, or was retried as a newer run while this attempt was still working.
export type NotCurrent = { outcome: "not_current"; depositionId: number; status: (typeof depositions.$inferSelect)["status"] | null };

// The advisory lock that serializes work on one deposition key. The upload endpoint takes the same
// lock, so an upload and a save of the same file can't interleave.
export function depositionLockKey(caseId: number, fileSha256: string, parserVersion: string): string {
  return `deposition:${caseId}:${fileSha256}:${parserVersion}`;
}

function batches<T>(rows: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) result.push(rows.slice(i, i + BATCH_SIZE));
  return result;
}

export function saveDeposition(db: Database, input: SaveInput): Promise<SaveResult>;
export function saveDeposition(db: Database, input: SaveInput, onlyIf: CurrentRun): Promise<SaveResult | NotCurrent>;
export async function saveDeposition(db: Database, input: SaveInput, onlyIf?: CurrentRun): Promise<SaveResult | NotCurrent> {
  const { read } = input;
  const { validation } = read;
  const key = and(
    eq(depositions.caseId, input.caseId),
    eq(depositions.fileSha256, input.fileSha256),
    eq(depositions.parserVersion, read.parserVersion),
  );

  return db.transaction(async (tx) => {
    // Held until this transaction ends; a concurrent save of the same key waits here, then sees
    // this one's committed rows and replaces them.
    const lockKey = depositionLockKey(input.caseId, input.fileSha256, read.parserVersion);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    // The row lock makes a retry or a recorded failure wait for this save, or this save see them.
    if (onlyIf) {
      const [target] = await tx
        .select({ status: depositions.status, run: depositions.ingestRun })
        .from(depositions)
        .where(eq(depositions.id, onlyIf.depositionId))
        .for("update");
      if (!target || target.status !== "processing" || target.run !== onlyIf.run) {
        return { outcome: "not_current", depositionId: onlyIf.depositionId, status: target?.status ?? null };
      }
    }

    const [previous] = await tx.select({ id: depositions.id, status: depositions.status }).from(depositions).where(key);
    // The worker's result must land on the deposition it was queued for, never on another one.
    if (onlyIf && previous?.id !== onlyIf.depositionId) {
      throw new Error(
        `deposition ${onlyIf.depositionId} is not the one stored under parser ${read.parserVersion} (${previous ? `that is deposition ${previous.id}` : "none is"})`,
      );
    }
    if (previous?.status === "ready" && validation.status !== "ready") {
      const [stored] = await tx
        .select({ parts: sql<number>`count(*)::int`, exchanges: countDistinct(exchanges.groupId) })
        .from(exchanges)
        .where(eq(exchanges.depositionId, previous.id));
      return {
        depositionId: previous.id,
        outcome: "kept_previous",
        status: "ready",
        lines: await tx.$count(lines, eq(lines.depositionId, previous.id)),
        exchanges: stored.exchanges,
        parts: stored.parts,
        attempt: validation,
      };
    }

    // Clear the previous ingestion's rows first: its exchanges reference its witness, which this
    // save may change. Exchanges go before the lines they point at.
    if (previous) {
      await tx.delete(exchanges).where(eq(exchanges.depositionId, previous.id));
      await tx.delete(lines).where(eq(lines.depositionId, previous.id));
    }

    const values = {
      caseId: input.caseId,
      witnessId: input.witnessId,
      takenOn: input.takenOn,
      fileSha256: input.fileSha256,
      storageKey: input.storageKey,
      sourceFormat: "pdf" as const,
      pageCount: validation.pageCount,
      needsOcrPages: validation.needsOcrPages,
      blankPages: validation.blankPages,
      validation,
      parserVersion: read.parserVersion,
      status: validation.status,
      ingestError: null,
    };
    const [deposition] = await tx
      .insert(depositions)
      .values(values)
      .onConflictDoUpdate({ target: [depositions.caseId, depositions.fileSha256, depositions.parserVersion], set: values })
      .returning({ id: depositions.id });
    const depositionId = deposition.id;
    const result: SaveResult = {
      depositionId,
      outcome: previous ? "replaced" : "created",
      status: validation.status,
      lines: 0,
      exchanges: 0,
      parts: 0,
      attempt: validation,
    };

    // Only a ready deposition has lines and exchanges (readDeposition builds them only then). The
    // others keep their validation report, so the pages that failed are still counted and shown.
    if (!read.exchanges) return result;
    const { lines: attributed, exchanges: whole, parts } = read.exchanges;

    for (const batch of batches(toLineRows(depositionId, attributed))) await tx.insert(lines).values(batch);
    const storedLines = await tx
      .select({ id: lines.id, printedPage: lines.printedPage, lineNo: lines.lineNo })
      .from(lines)
      .where(eq(lines.depositionId, depositionId));
    const lineIds = lineIdsByPosition(attributed, storedLines);

    const storedParts: { id: number; groupId: number; partNo: number }[] = [];
    for (const batch of batches(toExchangeRows(depositionId, input.witnessId, parts, lineIds))) {
      storedParts.push(
        ...(await tx
          .insert(exchanges)
          .values(batch)
          .returning({ id: exchanges.id, groupId: exchanges.groupId, partNo: exchanges.partNo })),
      );
    }
    for (const batch of batches(toExchangeLineRows(depositionId, parts, storedParts, lineIds))) {
      await tx.insert(exchangeLines).values(batch);
    }

    return { ...result, lines: attributed.length, exchanges: whole.length, parts: parts.length };
  });
}

