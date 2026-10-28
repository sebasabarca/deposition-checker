// The CLI's case and witness lookup under concurrent runs. See tests/db/database.ts for when it runs.

import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, orgs, witnesses } from "../../server/src/db/schema";
import { findOrCreateWitness } from "../../scripts/cases";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("CLI case lookup (Postgres)", () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => emptyTables(db));

  it("concurrent runs for the same case and witness create each of them once", async () => {
    // Open the pool's connections first, so the eight lookups run at the same time.
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`select pg_sleep(0.05)`)));
    const results = await Promise.all(Array.from({ length: 8 }, () => findOrCreateWitness(db, "U.S. v. Oracle", "Lawrence Ellison")));
    expect(new Set(results.map((r) => `${r.caseId}/${r.witnessId}`)).size).toBe(1);
    expect([await db.$count(orgs), await db.$count(cases), await db.$count(witnesses)]).toEqual([1, 1, 1]);
  });

  it("finds an existing case and adds a second witness to it", async () => {
    const first = await findOrCreateWitness(db, "U.S. v. Oracle", "Lawrence Ellison");
    const second = await findOrCreateWitness(db, "U.S. v. Oracle", "Safra Catz");
    expect(second.caseId).toBe(first.caseId);
    expect(second.witnessId).not.toBe(first.witnessId);
  });
});
