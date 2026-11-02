// Budget enforcement for paid model calls (DESIGN.md, "Per-job budget, enforced": "before each call
// the worker checks the call's maximum cost against what remains").
//
// A budget lives in Postgres. Before a request is sent, its worst-case cost is reserved in one atomic
// UPDATE that succeeds only if spent + reserved + the new reservation stays within the limit, so
// concurrent workers can never overspend the same budget. After the request:
//   settle     the response came back: the reservation becomes the actual recorded cost
//   release    the request certainly wasn't billed (the API rejected it with a 4xx)
//   uncertain  it may have been billed (timeout, connection loss, 5xx): counted at its full reservation
// A reservation a crash left open keeps counting until reconcileStale marks it uncertain. Every
// outcome errs toward counting more than was spent, never less.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { budgetReservations, budgets } from "../db/schema";
import { BATCH_MULTIPLIER, PRICES } from "./pricing";

export class BudgetExceeded extends Error {
  constructor(
    readonly budget: string,
    readonly neededUsd: number,
    readonly availableUsd: number,
  ) {
    super(`Budget "${budget}" can't reserve $${neededUsd.toFixed(6)}: $${availableUsd.toFixed(6)} available.`);
  }
}

// An upper bound on a request's input tokens from its characters: no tokenizer produces more tokens
// than characters, so this never underestimates, whatever the text.
export const inputTokenBound = (chars: number) => chars;

// The most a request can cost: every input token at the highest input-side rate our requests can be
// billed (a 5-minute cache write, 1.25x input), and output at max_tokens. For a model priced by prompt
// length, the tier the full prompt falls in. Throws for a model without a price: a call that can't be
// bounded can't be reserved, so it isn't sent.
export function maxRequestCost(model: string, { inputTokens, maxOutputTokens }: { inputTokens: number; maxOutputTokens: number }): number {
  const tiers = PRICES[model];
  if (!tiers) throw new Error(`No price for ${model}: its worst-case cost can't be reserved.`);
  const { rates } = tiers.find((t) => t.maxPromptTokens === null || inputTokens <= t.maxPromptTokens)!;
  const usd = (inputTokens * Math.max(rates.input, rates.cacheWrite5m) + maxOutputTokens * rates.output) / 1_000_000;
  return Math.ceil(usd * 1e8) / 1e8;
}

// The most a Batch API request can cost: batch halves every token type.
export const maxBatchRequestCost = (model: string, sizes: { inputTokens: number; maxOutputTokens: number }) => Math.ceil(maxRequestCost(model, sizes) * BATCH_MULTIPLIER * 1e8) / 1e8;

export async function ensureBudget(db: Database, name: string, limitUsd: number): Promise<number> {
  await db.insert(budgets).values({ name, limitUsd }).onConflictDoNothing();
  const [row] = await db.select().from(budgets).where(eq(budgets.name, name));
  if (row.limitUsd !== limitUsd) {
    throw new Error(`Budget "${name}" already exists with a limit of $${row.limitUsd}, not $${limitUsd}; it is never changed silently.`);
  }
  return row.id;
}

export async function budgetStatus(db: Database, budgetId: number) {
  const [row] = await db.select().from(budgets).where(eq(budgets.id, budgetId));
  return { name: row.name, limitUsd: row.limitUsd, spentUsd: row.spentUsd, reservedUsd: row.reservedUsd, availableUsd: row.limitUsd - row.spentUsd - row.reservedUsd };
}

// Reserves `maxUsd` before a request is sent, or throws BudgetExceeded without reserving anything.
export async function reserve(db: Database, budgetId: number, maxUsd: number, purpose: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [held] = await tx
      .update(budgets)
      .set({ reservedUsd: sql`${budgets.reservedUsd} + ${maxUsd}` })
      .where(and(eq(budgets.id, budgetId), sql`${budgets.spentUsd} + ${budgets.reservedUsd} + ${maxUsd} <= ${budgets.limitUsd}`))
      .returning({ id: budgets.id });
    if (!held) {
      const [row] = await tx.select().from(budgets).where(eq(budgets.id, budgetId));
      throw new BudgetExceeded(row?.name ?? String(budgetId), maxUsd, row ? row.limitUsd - row.spentUsd - row.reservedUsd : 0);
    }
    const [reservation] = await tx.insert(budgetReservations).values({ budgetId, purpose, maxUsd }).returning({ id: budgetReservations.id });
    return reservation.id;
  });
}

// Closes an open reservation: moves it out of `reserved` and adds `chargeUsd` to the budget's spend.
// Only a reservation still `reserved` changes, so closing it twice does nothing the second time.
async function close(
  db: Database,
  reservationId: number,
  status: "settled" | "released" | "uncertain",
  charge: (maxUsd: number) => number,
  fields: { actualUsd?: number | null; llmCallId?: number | null; note?: string | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(budgetReservations).where(eq(budgetReservations.id, reservationId)).for("update");
    if (!r || r.status !== "reserved") return false;
    const chargeUsd = charge(r.maxUsd);
    await tx
      .update(budgetReservations)
      .set({ status, actualUsd: fields.actualUsd ?? null, llmCallId: fields.llmCallId ?? null, note: fields.note ?? null, settledAt: new Date() })
      .where(eq(budgetReservations.id, reservationId));
    await tx
      .update(budgets)
      .set({ reservedUsd: sql`greatest(${budgets.reservedUsd} - ${r.maxUsd}, 0)`, spentUsd: sql`${budgets.spentUsd} + ${chargeUsd}` })
      .where(eq(budgets.id, r.budgetId));
    return true;
  });
}

// The response came back and was recorded. An unpriced call is charged its full reservation.
export function settle(db: Database, reservationId: number, call: { id: number; costUsd: number | null }) {
  return close(db, reservationId, "settled", (max) => call.costUsd ?? max, {
    actualUsd: call.costUsd,
    llmCallId: call.id,
    note: call.costUsd === null ? "unpriced model: charged the full reservation" : null,
  });
}

// The provider says it didn't run the request (an expired or cancelled batch item): nothing was billed.
export const releaseUnbilled = (db: Database, reservationId: number, note: string) => close(db, reservationId, "released", () => 0, { note: note.slice(0, 500) });

// The request failed. A 4xx means the API rejected it before generating anything: not billed, so the
// reservation is released. Anything else may have been billed: counted at its full reservation.
export function closeFailed(db: Database, reservationId: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (failureIsUnbilled(error)) return close(db, reservationId, "released", () => 0, { note: `rejected: ${message}`.slice(0, 500) });
  return close(db, reservationId, "uncertain", (max) => max, { note: `may have been billed: ${message}`.slice(0, 500) });
}

export function failureIsUnbilled(error: unknown): boolean {
  return error instanceof Anthropic.APIError && typeof error.status === "number" && error.status >= 400 && error.status < 500;
}

// Reservations still open after `olderThanMs` (a crash between the request and its settlement) are
// marked uncertain and counted at their full amount. Returns how many were closed.
export async function reconcileStale(db: Database, budgetId: number, olderThanMs: number, now = new Date()): Promise<number> {
  const stale = await db
    .select({ id: budgetReservations.id })
    .from(budgetReservations)
    .where(and(eq(budgetReservations.budgetId, budgetId), eq(budgetReservations.status, "reserved"), lt(budgetReservations.createdAt, new Date(now.getTime() - olderThanMs))));
  let closed = 0;
  for (const r of stale) if (await close(db, r.id, "uncertain", (max) => max, { note: "left open, likely by a crash: counted in full" })) closed++;
  return closed;
}
