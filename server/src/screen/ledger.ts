// Deferred-evidence ledger (Milestone 3, experimental): stores a screening run's results (screen/contract.ts)
// and each packet's adjudication progress, so adjudication can stop and resume without reading a packet twice.
// Deferred packets stay pending: unread, never compatible or "no contradiction". No entry is ever deleted.
// Nothing in production calls this yet.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { screeningEntries, screeningRuns } from "../db/schema";
import { ADJUDICATION_STATES, SCREENING_CONTRACT_VERSION, ScreeningResultSchema, type AdjudicationState, type ScreeningResult } from "./contract";

export type ScreeningRunInput = Omit<typeof screeningRuns.$inferInsert, "id" | "createdAt" | "contract">;
export type ScreeningEntry = typeof screeningEntries.$inferSelect;

// Validates every result first; a run with any invalid result, a repeated packet id or another strategy than
// the run's stores nothing.
export async function recordScreening(db: Database, run: ScreeningRunInput, results: readonly ScreeningResult[]): Promise<number> {
  const parsed = results.map((r, i) => {
    const p = ScreeningResultSchema.safeParse(r);
    if (!p.success) throw new Error(`screening result ${i} is invalid: ${p.error.message}`);
    if (p.data.strategy !== run.strategy || p.data.strategyVersion !== run.strategyVersion) throw new Error(`screening result ${i} comes from another strategy than the run`);
    return p.data;
  });
  if (new Set(parsed.map((r) => r.packetId)).size !== parsed.length) throw new Error("a packet id repeats in the screening results");
  // Every retrieved pair is in a packet or in the run's uncovered list: an incomplete run is never stored.
  const listed = parsed.reduce((n, r) => n + r.pairs.length, 0) + run.uncovered.length;
  if (listed !== run.poolPairs) throw new Error(`the results and uncovered list hold ${listed} pairs, the pool ${run.poolPairs}`);
  return db.transaction(async (tx) => {
    const [{ id }] = await tx.insert(screeningRuns).values({ ...run, contract: SCREENING_CONTRACT_VERSION }).returning({ id: screeningRuns.id });
    if (parsed.length)
      await tx.insert(screeningEntries).values(
        parsed.map((r) => ({
          runId: id, packetId: r.packetId, rank: r.rank, screenStatus: r.status, consolidatedInto: r.consolidatedInto, reason: r.reason,
          priority: r.priority, signals: r.signals, sessions: r.sessions, witnesses: r.witnesses, items: r.items, pairs: r.pairs,
          adjudicationStatus: r.adjudication,
        })),
      );
    return id;
  });
}

// Takes up to n prioritized, unstarted entries in rank order and marks them in progress. Concurrent claims
// skip each other's locked rows, so no packet is handed out twice.
export async function claimNext(db: Database, runId: number, n: number): Promise<ScreeningEntry[]> {
  const queue = db
    .select({ id: screeningEntries.id })
    .from(screeningEntries)
    .where(and(eq(screeningEntries.runId, runId), eq(screeningEntries.screenStatus, "prioritized"), eq(screeningEntries.adjudicationStatus, "not_started")))
    .orderBy(asc(screeningEntries.rank))
    .limit(n)
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(screeningEntries)
    .set({ adjudicationStatus: "in_progress", updatedAt: sql`now()` })
    .where(inArray(screeningEntries.id, queue))
    .returning();
  return claimed.sort((a, b) => a.rank! - b.rank!);
}

const fromInProgress = (runId: number, packetId: string) =>
  and(eq(screeningEntries.runId, runId), eq(screeningEntries.packetId, packetId), eq(screeningEntries.adjudicationStatus, "in_progress"));

// Only an in-progress entry can be adjudicated, so a packet is never adjudicated twice; the entries consolidated
// into it are adjudicated with it.
export async function markAdjudicated(db: Database, runId: number, packetId: string, ref: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(screeningEntries).set({ adjudicationStatus: "adjudicated", adjudicationRef: ref, updatedAt: sql`now()` }).where(fromInProgress(runId, packetId)).returning({ id: screeningEntries.id });
    if (!done.length) return false;
    await tx
      .update(screeningEntries)
      .set({ adjudicationStatus: "adjudicated", adjudicationRef: `via ${packetId}`, updatedAt: sql`now()` })
      .where(and(eq(screeningEntries.runId, runId), eq(screeningEntries.consolidatedInto, packetId), sql`${screeningEntries.adjudicationStatus} <> 'adjudicated'`));
    return true;
  });
}

export async function markFailed(db: Database, runId: number, packetId: string, note: string): Promise<boolean> {
  const failed = await db.update(screeningEntries).set({ adjudicationStatus: "failed", adjudicationNote: note, updatedAt: sql`now()` }).where(fromInProgress(runId, packetId)).returning({ id: screeningEntries.id });
  return failed.length > 0;
}

// Failed entries go back to the queue; the failure note is kept.
export async function retryFailed(db: Database, runId: number): Promise<number> {
  const retried = await db
    .update(screeningEntries)
    .set({ adjudicationStatus: "not_started", updatedAt: sql`now()` })
    .where(and(eq(screeningEntries.runId, runId), eq(screeningEntries.adjudicationStatus, "failed")))
    .returning({ id: screeningEntries.id });
  return retried.length;
}

// After a crashed worker, its claimed entries go back to the queue. Call it only when no worker is running
// on this run: a claim still being adjudicated would be read twice.
export async function releaseInProgress(db: Database, runId: number): Promise<number> {
  const released = await db
    .update(screeningEntries)
    .set({ adjudicationStatus: "not_started", adjudicationNote: "released after an interrupted run", updatedAt: sql`now()` })
    .where(and(eq(screeningEntries.runId, runId), eq(screeningEntries.adjudicationStatus, "in_progress")))
    .returning({ id: screeningEntries.id });
  return released.length;
}

// Deferred entries ranked within the new budget become prioritized. A budget never shrinks: entries already
// prioritized may be in progress or adjudicated.
export async function extendBudget(db: Database, runId: number, newBudget: number): Promise<number> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ budget: screeningRuns.budget }).from(screeningRuns).where(eq(screeningRuns.id, runId)).for("update");
    if (!run) throw new Error(`screening run ${runId} does not exist`);
    if (!Number.isInteger(newBudget) || newBudget < run.budget) throw new Error(`budget ${newBudget} would lower run ${runId}'s budget of ${run.budget}`);
    const promoted = await tx
      .update(screeningEntries)
      .set({ screenStatus: "prioritized", reason: sql`${`budget extended to ${newBudget}; `} || ${screeningEntries.reason}`, updatedAt: sql`now()` })
      .where(and(eq(screeningEntries.runId, runId), eq(screeningEntries.screenStatus, "deferred"), sql`${screeningEntries.rank} <= ${newBudget}`))
      .returning({ id: screeningEntries.id });
    await tx.update(screeningRuns).set({ budget: newBudget }).where(eq(screeningRuns.id, runId));
    return promoted.length;
  });
}

const tally = (values: readonly string[]) => {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
};

export type LedgerSummary = {
  poolPairs: number;
  packetedPairs: number;
  uncoveredPairs: number;
  uncoveredByReason: Record<string, number>;
  packets: number;
  prioritized: number;
  deferred: number;
  consolidated: number;
  adjudication: Record<AdjudicationState, number>;
  pending: number; // every packet not adjudicated, whatever its screen status: deferred is pending, never compatible
  deferredReasons: Record<string, number>;
  adjudicatedPairs: number; // pairs in adjudicated packets, consolidated members included
  pendingPairs: number;
};

// Pure: the counts for one run's stored row and entries.
export function summarize(run: Pick<typeof screeningRuns.$inferSelect, "poolPairs" | "uncovered">, entries: readonly Pick<ScreeningEntry, "screenStatus" | "adjudicationStatus" | "reason" | "pairs">[]): LedgerSummary {
  const status = (s: string) => entries.filter((e) => e.screenStatus === s).length;
  const adjudication = Object.fromEntries(ADJUDICATION_STATES.map((s) => [s, entries.filter((e) => e.adjudicationStatus === s).length])) as Record<AdjudicationState, number>;
  const pairs = (es: readonly { pairs: unknown[] }[]) => es.reduce((n, e) => n + e.pairs.length, 0);
  const done = entries.filter((e) => e.adjudicationStatus === "adjudicated");
  return {
    poolPairs: run.poolPairs,
    packetedPairs: pairs(entries),
    uncoveredPairs: run.uncovered.length,
    uncoveredByReason: tally(run.uncovered.map((u) => u.reason)),
    packets: entries.length,
    prioritized: status("prioritized"),
    deferred: status("deferred"),
    consolidated: status("consolidated"),
    adjudication,
    pending: entries.length - done.length,
    // By the reason's kind (the text before its first colon), not its packet-specific rank and signals.
    deferredReasons: tally(entries.filter((e) => e.screenStatus === "deferred").map((e) => e.reason.split(":")[0])),
    adjudicatedPairs: pairs(done),
    pendingPairs: pairs(entries) - pairs(done),
  };
}

export async function ledgerSummary(db: Database, runId: number): Promise<LedgerSummary> {
  const [run] = await db.select().from(screeningRuns).where(eq(screeningRuns.id, runId));
  if (!run) throw new Error(`screening run ${runId} does not exist`);
  return summarize(run, await db.select().from(screeningEntries).where(eq(screeningEntries.runId, runId)));
}

// The packet's original references: its item keys with source hashes, and the pool pairs it answers for.
export async function entryEvidence(db: Database, runId: number, packetId: string) {
  const [e] = await db.select({ items: screeningEntries.items, pairs: screeningEntries.pairs }).from(screeningEntries).where(and(eq(screeningEntries.runId, runId), eq(screeningEntries.packetId, packetId)));
  return e ?? null;
}

// Entries whose evidence changed since screening: an item's source hash differs, or its key is gone.
export async function staleEntries(db: Database, runId: number, current: ReadonlyMap<string, string>) {
  const entries = await db.select({ packetId: screeningEntries.packetId, items: screeningEntries.items }).from(screeningEntries).where(eq(screeningEntries.runId, runId)).orderBy(asc(screeningEntries.id));
  return entries
    .map((e) => ({ packetId: e.packetId, changed: e.items.filter((i) => current.get(i.key) !== i.sourceHash).map((i) => i.key) }))
    .filter((e) => e.changed.length > 0);
}
