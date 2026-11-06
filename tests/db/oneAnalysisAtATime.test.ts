// One analysis at a time per workspace, a case that can't be deleted under a running analysis, and a finding whose
// reply named its two exchanges in the other order. Synthetic Webb and Whitfield sessions in two cases of one
// organization; test model and stub queue only: no key is used, nothing is sent.

import { eq, sql } from "drizzle-orm";
import express from "express";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseRunRoutes, depositionRoutes } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { caseRuns, depositions, findings } from "../../server/src/db/schema";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunFindings, createCaseRun, runCaseRun, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("one analysis at a time", () => {
  let db: Database;
  let pool: Pool;
  let webbCase: number;
  let whitfieldCase: number;
  let server: { url: string; close: () => Promise<void> };
  const plain: CaseRunDeps = { adjudicator: () => null, minilm: "off", sleep: async () => undefined };
  const call = (method: string, path: string, body?: unknown) => fetch(`${server.url}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs cascade`);
    const webb = await storeSessions(db, WEBB_SUITE);
    const whitfield = await storeSessions(db, WHITFIELD_SUITE);
    [{ caseId: webbCase }] = await db.select({ caseId: depositions.caseId }).from(depositions).where(eq(depositions.id, webb.depositionIds[0]));
    [{ caseId: whitfieldCase }] = await db.select({ caseId: depositions.caseId }).from(depositions).where(eq(depositions.id, whitfield.depositionIds[0]));
    expect(webbCase).not.toBe(whitfieldCase);
    const boss = { send: async () => null } as unknown as PgBoss;
    const app = express();
    app.use(express.json());
    // A placeholder key: confirmation checks that one is configured before anything else; the stub queue runs nothing.
    app.use("/api", caseRunRoutes({ db, boss, env: { ALLOW_TEST_RUNS: "true", ANTHROPIC_API_KEY: "placeholder-never-used" } }));
    app.use("/api", depositionRoutes({ db, pool, boss }));
    server = await listen(app);
  }, 120_000);
  afterAll(async () => { await server?.close(); await pool?.end(); });

  it("while one case is analyzed, another can prepare an estimate but not start, confirm or resume", async () => {
    const running = await createCaseRun(db, webbCase, { mode: "live", budgetUsd: 5, confirmed: true }); // confirmed: it is running
    const listed = await (await call("GET", `/cases/${whitfieldCase}/case-runs`)).json();
    expect(listed.runningElsewhere).toMatchObject({ caseId: webbCase, caseRunId: running.id });
    expect((await (await call("GET", `/cases/${webbCase}/case-runs`)).json()).runningElsewhere).toBeNull(); // its own case

    expect((await call("POST", `/cases/${whitfieldCase}/case-runs`, { mode: "live" })).status).toBe(202); // an estimate: allowed
    const mock = await call("POST", `/cases/${whitfieldCase}/case-runs`, { mode: "mock" });
    expect(mock.status).toBe(409); // the estimate above is still open on this case, or another analysis runs: either way, not started
    await db.update(caseRuns).set({ status: "cancelled" }).where(eq(caseRuns.caseId, whitfieldCase));
    const mock2 = await call("POST", `/cases/${whitfieldCase}/case-runs`, { mode: "mock" });
    expect(mock2.status).toBe(409);
    expect((await mock2.json()).code).toBe("analysis_running");

    const estimate = await createCaseRun(db, whitfieldCase, { mode: "live" });
    await db.update(caseRuns).set({ status: "awaiting_confirmation" }).where(eq(caseRuns.id, estimate.id));
    const confirm = await call("POST", `/case-runs/${estimate.id}/confirm`, { budgetUsd: 5 });
    expect(confirm.status).toBe(409);
    expect((await confirm.json()).code).toBe("analysis_running");
    await db.update(caseRuns).set({ status: "incomplete" }).where(eq(caseRuns.id, estimate.id));
    const resume = await call("POST", `/case-runs/${estimate.id}/resume`, {});
    expect([403, 409]).toContain(resume.status); // 403 without analysis access; the running check comes after it
    expect(await db.select({ s: caseRuns.status }).from(caseRuns).where(eq(caseRuns.id, estimate.id))).toEqual([{ s: "incomplete" }]);

    await db.update(caseRuns).set({ status: "cancelled" }).where(eq(caseRuns.id, running.id));
    expect((await (await call("GET", `/cases/${whitfieldCase}/case-runs`)).json()).runningElsewhere).toBeNull();
  }, 60_000);

  it("refuses to delete a case while its analysis runs, including while it settles costs", async () => {
    const run = await createCaseRun(db, webbCase, { mode: "live", budgetUsd: 5, confirmed: true });
    for (const status of ["adjudicating", "reconciling"] as const) {
      await db.update(caseRuns).set({ status }).where(eq(caseRuns.id, run.id));
      expect((await call("DELETE", `/cases/${webbCase}`)).status).toBe(409);
    }
    await db.update(caseRuns).set({ status: "cancelled" }).where(eq(caseRuns.id, run.id));
  });

  it("shows each side's citation on the passage that holds it, even when the reply named the exchanges the other way round", async () => {
    await db.update(caseRuns).set({ status: "cancelled" }).where(sql`status not in ('completed', 'cancelled', 'failed', 'incomplete')`);
    const run = await createCaseRun(db, webbCase, { mode: "mock", contract: "packet-v1" }); // its test model cites lines
    expect(await runCaseRun(db, pool, run.id, plain)).toBe("completed");
    const shown = (await caseRunFindings(db, run.id)).find((f) => f.verification.a.lineIds.length && f.verification.b.lineIds.length)!;
    expect(shown).toBeDefined();
    const [row] = await db.select({ checks: findings.checks }).from(findings).where(eq(findings.id, shown.id));
    const checks = row.checks as { source: { a: unknown; b: unknown } };
    await db.update(findings).set({ checks: { ...checks, source: { a: checks.source.b, b: checks.source.a } } }).where(eq(findings.id, shown.id));
    const again = (await caseRunFindings(db, run.id)).find((f) => f.id === shown.id)!;
    expect(again.verification).toEqual(shown.verification);
    for (const side of ["a", "b"] as const) expect(again.verification[side].lineIds.every((id) => again[side].lines.some((l) => l.id === id))).toBe(true);
  }, 180_000);
});
