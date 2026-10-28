// Shared setup for the database tests. They need Postgres (`npm run db:up`) and run only when
// TEST_DATABASE_URL is set, so `npm test` still works without Docker. The test database is wiped,
// so its name must end in "_test". Every file resets the same database, so vitest.config.mts runs
// test files one at a time.

import "dotenv/config";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { connect, type Database } from "../../server/src/db/client";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Drops everything in the test database, including pg-boss's queue, and applies the migrations from scratch.
export async function openTestDatabase(migrationsFolder = "drizzle") {
  if (!new URL(TEST_DATABASE_URL!).pathname.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL must name a database ending in "_test"; got ${TEST_DATABASE_URL}`);
  }
  const { db, pool } = connect(TEST_DATABASE_URL);
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public;`);
  await migrate(db, { migrationsFolder });
  return { db, pool };
}

// Empties every table, and pg-boss's jobs when its schema exists: IDs restart at 1, so a job left
// from an earlier test would otherwise look like it belongs to a new deposition.
export async function emptyTables(db: Database) {
  await db.execute(sql`truncate orgs, cases, witnesses, depositions, lines, exchanges, exchange_lines, llm_calls restart identity cascade`);
  await db.execute(sql`do $$ begin if to_regclass('pgboss.job') is not null then delete from pgboss.job; end if; end $$`);
}

// The Postgres error behind a failed insert: its constraint name, or its error code.
export async function violation(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const pg = ((error as { cause?: unknown }).cause ?? error) as { constraint?: string; code?: string };
    return pg.constraint ?? pg.code ?? "unknown error";
  }
  throw new Error("expected the database to reject this, but it was accepted");
}

// Starts an Express app on a free port, for tests that call endpoints over HTTP.
export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// The pg-boss jobs queued in `queue` for one deposition, oldest first.
export async function jobsFor(db: Database, queue: string, depositionId: number) {
  const result = await db.execute<{ state: string; retry_count: number }>(
    sql`select state, retry_count from pgboss.job where name = ${queue} and data->>'depositionId' = ${String(depositionId)} order by created_on`,
  );
  return result.rows;
}
