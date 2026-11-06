// Which stretch render a stretch-v2 run used: recorded at creation (r2), and for a run created before r2 existed
// (no stretchRender in its config), recorded once when it is worked on again. Synthetic Webb + Whitfield; test model.
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRETCH_RENDER_R1, STRETCH_RENDER_R2 } from "../../server/src/adjudicate/stretchPrompt";
import type { Database } from "../../server/src/db/client";
import { caseRuns, depositions } from "../../server/src/db/schema";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { createCaseRun, runCaseRun } from "../../server/src/jobs/caseRun";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("stretch render recorded on stretch-v2 runs", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await db.execute(sql`truncate case_runs cascade`);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
  }, 120_000);
  afterAll(async () => { await pool?.end(); });
  const config = async (id: number) => (await db.select({ c: caseRuns.config }).from(caseRuns).where(eq(caseRuns.id, id)))[0].c as Record<string, unknown>;
  const deps = { adjudicator: () => null, minilm: "off" as const, sleep: async () => undefined };

  it("a new stretch run records r2 and keeps it", async () => {
    const run = await createCaseRun(db, caseId, { mode: "mock", contract: "stretch-v2" });
    expect((await config(run.id)).stretchRender).toBe(STRETCH_RENDER_R2);
    expect(await runCaseRun(db, pool, run.id, deps)).toBe("completed");
    const c = await config(run.id);
    expect(c.stretchRender).toBe(STRETCH_RENDER_R2);
    expect(c.stretchRenderEarlier).toBeUndefined();
  }, 120_000);

  it("a run created before r2 (no stretchRender) records when its later requests switch from r1", async () => {
    const run = await createCaseRun(db, caseId, { mode: "mock", contract: "stretch-v2" });
    const { stretchRender: _r, ...old } = await config(run.id);
    await db.update(caseRuns).set({ config: old }).where(eq(caseRuns.id, run.id));
    expect(await runCaseRun(db, pool, run.id, deps)).toBe("completed");
    const c = await config(run.id);
    expect(c.stretchRender).toBe(STRETCH_RENDER_R2);
    expect(c.stretchRenderEarlier).toMatchObject({ render: STRETCH_RENDER_R1 });
  }, 120_000);

  it("a packet-v1 run records no stretch render", async () => {
    const run = await createCaseRun(db, caseId, { mode: "mock" });
    expect(await runCaseRun(db, pool, run.id, deps)).toBe("completed");
    expect((await config(run.id)).stretchRender).toBeUndefined();
  }, 120_000);
});
