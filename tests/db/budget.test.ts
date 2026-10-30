// Budget enforcement against the test database: atomic reservations under concurrency, exhaustion,
// settlement, failures, crashes and retries. See tests/db/database.ts for when these run.

import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { budgetStatus, BudgetExceeded, closeFailed, ensureBudget, reconcileStale, reserve, settle } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { budgetReservations } from "../../server/src/db/schema";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

// An API error as the SDK raises it, with an HTTP status.
const apiError = (status: number) => Object.assign(Object.create(Anthropic.APIError.prototype), { status, message: `HTTP ${status}` });

describe.skipIf(!TEST_DATABASE_URL)("budgets (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let budget: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await emptyTables(db);
    budget = await ensureBudget(db, "pilot", 1);
  });

  const status = () => budgetStatus(db, budget);

  it("reserves within the limit and refuses a reservation that would exceed it, reserving nothing", async () => {
    await reserve(db, budget, 0.7, "first");
    await expect(reserve(db, budget, 0.31, "second")).rejects.toBeInstanceOf(BudgetExceeded);
    expect(await status()).toMatchObject({ spentUsd: 0, reservedUsd: 0.7, availableUsd: expect.closeTo(0.3, 9) });
    expect(await db.$count(budgetReservations)).toBe(1);
    await reserve(db, budget, 0.3, "exactly the rest");
    expect((await status()).availableUsd).toBeCloseTo(0, 9);
  });

  it("never lets concurrent workers overspend: 20 simultaneous reservations of 0.1 against a limit of 1", async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => reserve(db, budget, 0.1, `worker ${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof BudgetExceeded)).toBe(true);
    expect((await status()).reservedUsd).toBeCloseTo(1, 9);
    expect(await db.$count(budgetReservations)).toBe(10);
  });

  it("settles at the actual recorded cost, and closing twice changes nothing the second time", async () => {
    const r = await reserve(db, budget, 0.5, "call");
    expect(await settle(db, r, { id: null as never, costUsd: 0.02 })).toBe(true);
    expect(await status()).toMatchObject({ spentUsd: 0.02, reservedUsd: 0 });
    expect(await settle(db, r, { id: null as never, costUsd: 0.4 })).toBe(false);
    expect((await status()).spentUsd).toBe(0.02);
  });

  it("charges an unpriced call its full reservation", async () => {
    const r = await reserve(db, budget, 0.5, "call");
    await settle(db, r, { id: null as never, costUsd: null });
    expect(await status()).toMatchObject({ spentUsd: 0.5, reservedUsd: 0 });
  });

  it("releases a request the API rejected (4xx), and counts one that may have been billed (timeout, 5xx) in full", async () => {
    const rejected = await reserve(db, budget, 0.2, "rejected");
    const timedOut = await reserve(db, budget, 0.3, "timed out");
    const serverError = await reserve(db, budget, 0.1, "5xx");
    await closeFailed(db, rejected, apiError(400));
    await closeFailed(db, timedOut, new Error("Request timed out."));
    await closeFailed(db, serverError, apiError(529));
    expect(await status()).toMatchObject({ spentUsd: 0.4, reservedUsd: 0 });
    const rows = await db.select().from(budgetReservations).orderBy(budgetReservations.id);
    expect(rows.map((r) => r.status)).toEqual(["released", "uncertain", "uncertain"]);
  });

  it("counts every retry: each attempt reserves on its own, and an uncertain first attempt stays counted", async () => {
    const first = await reserve(db, budget, 0.3, "attempt 1");
    await closeFailed(db, first, new Error("socket hang up"));
    const second = await reserve(db, budget, 0.3, "attempt 2");
    await settle(db, second, { id: null as never, costUsd: 0.05 });
    expect((await status()).spentUsd).toBeCloseTo(0.35, 9);
  });

  it("keeps a reservation a crash left open counted until reconciled, then counts it in full", async () => {
    const open = await reserve(db, budget, 0.6, "crashed mid-request");
    expect((await status()).availableUsd).toBeCloseTo(0.4, 9);
    await expect(reserve(db, budget, 0.5, "next")).rejects.toBeInstanceOf(BudgetExceeded);
    expect(await reconcileStale(db, budget, 60_000, new Date(Date.now() + 120_000))).toBe(1);
    const [row] = await db.select().from(budgetReservations).where(eq(budgetReservations.id, open));
    expect(row.status).toBe("uncertain");
    expect(await status()).toMatchObject({ spentUsd: 0.6, reservedUsd: 0 });
    expect(await reconcileStale(db, budget, 60_000, new Date(Date.now() + 120_000))).toBe(0); // only once
  });

  it("won't silently change an existing budget's limit", async () => {
    expect(await ensureBudget(db, "pilot", 1)).toBe(budget);
    await expect(ensureBudget(db, "pilot", 5)).rejects.toThrow("never changed silently");
  });
});
