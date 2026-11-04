// Vitest setup for the integration project: gives every Vitest worker its own Postgres database, so
// integration files run in parallel without sharing state. Worker N uses `<base>_w<N>_test` (for
// deposition_checker_test: deposition_checker_w1_test, ...), created on first use; each file still drops
// and re-migrates its database (openTestDatabase), so isolation per file is unchanged. Runs before
// any test module loads, so database.ts and the evaluation helpers read the worker's URL.

import "dotenv/config";
import pg from "pg";

export function workerDatabaseUrl(base: string, poolId: string) {
  const url = new URL(base);
  const name = url.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`TEST_DATABASE_URL must name a database ending in "_test"; got ${name}`);
  url.pathname = `/${name.slice(0, -"_test".length)}_w${poolId}_test`;
  return url.toString();
}

const base = process.env.TEST_DATABASE_URL;
const poolId = process.env.VITEST_POOL_ID;
if (base && poolId) {
  const target = workerDatabaseUrl(base, poolId);
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  try {
    const name = new URL(target).pathname.slice(1);
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) {
      try {
        await client.query(`create database "${name}"`);
      } catch (e) {
        if ((e as { code?: string }).code !== "42P04") throw e; // created meanwhile by another run: fine
      }
    }
  } finally {
    await client.end();
  }
  process.env.TEST_DATABASE_URL = target;
}
