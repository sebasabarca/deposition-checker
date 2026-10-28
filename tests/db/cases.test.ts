// The CLI's case and witness lookup under concurrent runs. See tests/db/database.ts for when it runs.

import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, orgs, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION } from "../../server/src/ingest";
import { findOrCreateWitness, resolveDeposition, resolveWitness } from "../../scripts/cases";
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

  describe("read-only lookup for scripts/pathb.ts", () => {
    async function twoCasesWithTheSameName() {
      const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
      const made = [];
      for (let i = 0; i < 2; i++) {
        const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
        const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
        made.push({ caseId: kase.id, witnessId: witness.id });
      }
      return made;
    }

    let fileNo = 0;
    async function deposition(target: { caseId: number; witnessId: number }, status: "ready" | "failed" = "ready") {
      const [row] = await db
        .insert(depositions)
        .values({
          ...target,
          fileSha256: String(++fileNo).padStart(64, "0"),
          storageKey: "x.pdf",
          parserVersion: PARSER_VERSION,
          status,
          ...(status === "ready" ? { pageCount: 1, validation: { status: "ready" } as never } : { ingestError: "boom" }),
        })
        .returning();
      return row.id;
    }

    it("rejects a case name shared by two cases, naming their IDs, and resolves either by --case-id", async () => {
      const [first, second] = await twoCasesWithTheSameName();
      await expect(resolveWitness(db, { caseName: "U.S. v. Oracle", witnessName: "Lawrence Ellison" })).rejects.toThrow(
        `matches 2 cases (IDs ${first.caseId}, ${second.caseId}); choose one with --case-id`,
      );
      expect(await resolveWitness(db, { caseId: second.caseId, witnessName: "Lawrence Ellison" })).toEqual(second);
    });

    it("resolves a name that matches exactly one case and witness, and says so when nothing matches", async () => {
      const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
      const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
      const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
      expect(await resolveWitness(db, { caseName: "U.S. v. Oracle", witnessName: "Lawrence Ellison" })).toEqual({ caseId: kase.id, witnessId: witness.id });
      await expect(resolveWitness(db, { caseName: "U.S. v. Oracle", witnessName: "Safra Catz" })).rejects.toThrow('No witness "Safra Catz"');
      await expect(resolveWitness(db, { witnessName: "Lawrence Ellison" })).rejects.toThrow("--case-id <id> or --case <name>");
    });

    it("accepts a deposition only if it is a ready deposition of the resolved case and witness", async () => {
      const [first, second] = await twoCasesWithTheSameName();
      const own = await deposition(first);
      const latest = await deposition(first);
      const elsewhere = await deposition(second);
      const failed = await deposition(first, "failed");

      expect(await resolveDeposition(db, first, own)).toBe(own);
      expect(await resolveDeposition(db, first)).toBe(latest); // the most recent ready one
      await expect(resolveDeposition(db, first, elsewhere)).rejects.toThrow(`belongs to case ${second.caseId}`);
      await expect(resolveDeposition(db, first, failed)).rejects.toThrow("is failed; only ready depositions are searched");
      await expect(resolveDeposition(db, first, 999_999)).rejects.toThrow("doesn't exist");
    });
  });
});
