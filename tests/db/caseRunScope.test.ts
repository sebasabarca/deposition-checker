// Analyses of selected depositions: a case run limited to the depositions a person chose goes through the same
// pipeline as a whole-case run (retrieval, estimate, test model), and reads only pairs inside that selection.
// Synthetic Webb and Whitfield sessions in one case; test model only, no key, no network.

import { eq, sql } from "drizzle-orm";
import express from "express";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseRunRoutes } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { candidates, depositions } from "../../server/src/db/schema";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunReport, caseRunSetOf, createCaseRun, runCaseRun, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("case runs of selected depositions", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let webb: number[];
  let whitfield: number[];
  const plain: CaseRunDeps = { adjudicator: () => null, minilm: "off", sleep: async () => undefined };
  const depositionsRead = async (runId: number) => (await db.execute<{ d: number }>(sql`select distinct unnest(array[deposition_a, deposition_b]) as d from candidates where candidate_set = ${caseRunSetOf(runId)} order by 1`)).rows.map((r) => Number(r.d));

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs cascade`);
    webb = (await storeSessions(db, WEBB_SUITE)).depositionIds;
    whitfield = (await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName })).depositionIds;
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).where(eq(depositions.id, webb[0]));
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  it("reads only pairs inside the selection, and the whole case reads more", async () => {
    const whole = await createCaseRun(db, caseId, { mode: "mock" });
    expect(await runCaseRun(db, pool, whole.id, plain)).toBe("completed");
    const scoped = await createCaseRun(db, caseId, { mode: "mock", depositionIds: [webb[1], webb[0]] });
    expect(await runCaseRun(db, pool, scoped.id, plain)).toBe("completed");

    expect(await depositionsRead(scoped.id)).toEqual([...webb].sort((a, b) => a - b));
    expect((await depositionsRead(whole.id)).length).toBeGreaterThan(2);
    const n = async (id: number) => (await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, caseRunSetOf(id)))).length;
    expect(await n(scoped.id)).toBeGreaterThan(0);
    expect(await n(scoped.id)).toBeLessThan(await n(whole.id));

    const report = (await caseRunReport(db, scoped.id))!;
    expect(report.scope).toEqual({ kind: "depositions", depositionIds: [...webb].sort((a, b) => a - b) });
    expect((await caseRunReport(db, whole.id))!.scope).toEqual({ kind: "case" });
  }, 180_000);

  it("prepares the cost estimate from the selection alone (a live run stops at the estimate, nothing sent)", async () => {
    const live = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 0, depositionIds: [webb[0], whitfield[0]] });
    const never: CaseRunDeps = { ...plain, adjudicator: () => { throw new Error("no model call before confirmation"); } };
    expect(await runCaseRun(db, pool, live.id, never)).toBe("awaiting_confirmation");
    const r = (await caseRunReport(db, live.id))!;
    expect((r.estimate as { packets?: number } | null)?.packets).toBeGreaterThan(0);
    expect(await depositionsRead(live.id)).toEqual([webb[0], whitfield[0]].sort((a, b) => a - b));
  }, 180_000);

  it("refuses test-model runs over the API unless the server allows them", async () => {
    const boss = { send: async () => null } as unknown as PgBoss;
    const app = express();
    app.use(express.json());
    app.use("/api", (req, res, next) => caseRunRoutes({ db, boss, env: {} })(req, res, next));
    const server = await listen(app);
    try {
      const r = await fetch(`${server.url}/api/cases/${caseId}/case-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "mock" }) });
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe("test_runs_disabled");
    } finally {
      await server.close();
    }
  });

  it("validates the selection over the API: same case, ready, at least two sessions", async () => {
    await db.execute(sql`update case_runs set status = 'cancelled' where status in ('queued', 'retrieving', 'awaiting_confirmation', 'adjudicating')`);
    const boss = { send: async () => null } as unknown as PgBoss;
    const app = express();
    app.use(express.json());
    app.use("/api", (req, res, next) => caseRunRoutes({ db, boss, env: { ALLOW_TEST_RUNS: "true" } })(req, res, next));
    const server = await listen(app);
    const post = (body: unknown) => fetch(`${server.url}/api/cases/${caseId}/case-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post({ mode: "mock", depositionIds: [webb[0]] })).status).toBe(400); // fewer than two
      const foreign = await post({ mode: "mock", depositionIds: [webb[0], 999_999] });
      expect(foreign.status).toBe(400);
      expect((await foreign.json()).code).toBe("scope_invalid");
      const ok = await post({ mode: "live", depositionIds: [webb[0], webb[1]] });
      expect(ok.status).toBe(202);
      expect((await ok.json()).caseRun.scope).toEqual({ kind: "depositions", depositionIds: [...webb].sort((a, b) => a - b) });
    } finally {
      await server.close();
    }
  }, 60_000);
});
