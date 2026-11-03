// Stage 2 on the real fixtures (data/eval/facts-expected-v1.json): hand-authored fact records for the
// Hutchinson limo/SUV, the Simpson-Resnick dog and alley passages and compatible controls, run through
// the real pipeline. They show what the schema expresses and what verification accepts or rejects. They
// are not model output, so nothing here measures extraction quality or recall.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { loadEvidenceFixtures, missingFixtureFiles, readEvidenceFixture, type LoadedFixtures } from "../../server/src/eval/evidenceFixtures";
import { readFactExpectations, runFactChecks } from "../../server/src/eval/factFixtures";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const FIXTURE = readEvidenceFixture();
const missing = missingFixtureFiles(FIXTURE);
if (missing.length && TEST_DATABASE_URL) console.warn(`factsReal: SKIPPED, local fixture files missing: ${missing.join(", ")}. Run \`npx tsx scripts/facts.ts eval-real\` for an evaluation that fails instead.`);

describe.skipIf(!TEST_DATABASE_URL || missing.length > 0)("fact extraction pipeline (Postgres, real fixtures, hand-authored records)", () => {
  let db: Database;
  let pool: Pool;
  let l: LoadedFixtures;
  let result: Awaited<ReturnType<typeof runFactChecks>>;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    l = await loadEvidenceFixtures(db, FIXTURE);
    result = await runFactChecks(db, l, readFactExpectations());
  }, 300_000);
  afterAll(async () => {
    await pool?.end();
  });

  it("passes every check", () => {
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(40);
  });

  it("indexes the expected records and nothing from the stand-in's empty units", () => {
    expect(result.indexed).toBe(13); // 14 records, one of them an attorney's unadopted question
  });
});
