// The cross-case screens' data, built on whole-case analyses (api/findings.ts workspace, api/cases.ts summaries and
// detail): each case's latest analysis's findings with their lanes, the counts the case list shows, and the
// analyses a case has. Synthetic Webb and Whitfield testimony in one case, test model only: no key, nothing sent.

import { eq } from "drizzle-orm";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseRoutes, findingRoutes } from "../../server/src/api";
import { findingGroup } from "../../server/src/api/present";
import type { Database } from "../../server/src/db/client";
import { caseRuns, depositions, findings as findingsTable } from "../../server/src/db/schema";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunFindings, createCaseRun, runCaseRun, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { captureEpochs } from "../../server/src/evidence/epoch";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("the workspace on whole-case analyses", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let server: { url: string; close: () => Promise<void> };
  const plain: CaseRunDeps = { adjudicator: () => null, minilm: "off", sleep: async () => undefined };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${server.url}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json();
  };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    const { depositionIds } = await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).where(eq(depositions.id, depositionIds[0]));
    const app = express().use(express.json()).use("/api", caseRoutes({ db })).use("/api", findingRoutes({ db }));
    server = await listen(app);
  }, 120_000);
  afterAll(async () => { await server?.close(); await pool?.end(); });

  it("lists nothing before an analysis, then the latest analysis's findings, with the case list's counts agreeing", async () => {
    expect((await call("GET", "/workspace")).findings).toEqual([]);
    expect((await call("GET", `/cases/${caseId}`)).runs).toEqual([]);
    // An estimate nobody confirmed is not an analysis: it counts nowhere.
    await createCaseRun(db, caseId, { mode: "live" });
    expect((await call("GET", `/cases/${caseId}`)).runs).toEqual([]);

    const older = await createCaseRun(db, caseId, { mode: "mock", contract: "packet-v1" });
    expect(await runCaseRun(db, pool, older.id, plain)).toBe("completed");
    const run = await createCaseRun(db, caseId, { mode: "mock", contract: "packet-v1" });
    expect(await runCaseRun(db, pool, run.id, plain)).toBe("completed");

    // Whatever the test model concluded, one finding becomes a verified, scored contradiction, so a decision waits.
    const [first] = await caseRunFindings(db, run.id);
    await db.update(findingsTable).set({ type: "direct", priority: "high", score: 80, band: "high", evidenceStatus: "verified", unscoredReason: null }).where(eq(findingsTable.id, first.id));

    const w = await call("GET", "/workspace");
    const stored = await caseRunFindings(db, run.id);
    expect(stored.length).toBeGreaterThan(0);
    expect(w.findings.find((f: { id: number }) => f.id === first.id).lane).toBe("contradictions");
    // Only the latest analysis: a case analyzed twice doesn't list its findings twice.
    expect(w.findings.map((f: { id: number }) => f.id).sort((a: number, b: number) => a - b)).toEqual(stored.map((f) => f.id).sort((a, b) => a - b));
    expect(w.findings.every((f: { runId: number; caseId: number }) => f.runId === run.id && f.caseId === caseId)).toBe(true);
    for (const f of w.findings) expect(f.lane).toBe(findingGroup(stored.find((s) => s.id === f.id)!));

    const waiting = w.findings.filter((f: { lane: string; reviewState: string }) => (f.lane === "contradictions" || f.lane === "needs_context") && f.reviewState === "unreviewed").length;
    expect(waiting).toBeGreaterThan(0);
    const summary = w.cases.find((c: { id: number }) => c.id === caseId);
    expect(summary).toMatchObject({ findings: stored.length, needsReview: waiting, reports: 2, checking: false, lastAnalysis: { id: run.id, status: "completed" } });
    const detail = await call("GET", `/cases/${caseId}`);
    expect(detail.case.findings).toBe(stored.length);
    expect(detail.runs.map((r: { id: number }) => r.id)).toEqual([run.id, older.id]);

    // A decision saved through the same route the review page uses leaves one fewer waiting.
    const open = w.findings.find((f: { lane: string; reviewState: string }) => f.lane === "contradictions" && f.reviewState === "unreviewed") ?? w.findings.find((f: { lane: string; reviewState: string }) => f.lane === "needs_context" && f.reviewState === "unreviewed");
    const sides = stored.find((s) => s.id === open.id)!;
    const saved = await call("PATCH", `/findings/${open.id}/review`, { decision: "confirmed", epochs: await captureEpochs(db, [sides.a.depositionId, sides.b.depositionId]) });
    expect(saved.review.reviewState).toBe("confirmed");
    expect((await call("GET", "/cases")).cases.find((c: { id: number }) => c.id === caseId).needsReview).toBe(waiting - 1);
  }, 240_000);

  it("shows a running analysis as checking, with the run in the workspace's running list", async () => {
    const running = await createCaseRun(db, caseId, { mode: "mock", contract: "packet-v1" });
    await db.update(caseRuns).set({ status: "adjudicating" }).where(eq(caseRuns.id, running.id));
    const w = await call("GET", "/workspace");
    expect(w.caseRuns.map((r: { id: number }) => r.id)).toEqual([running.id]);
    expect(w.cases.find((c: { id: number }) => c.id === caseId)).toMatchObject({ checking: true, lastAnalysis: { id: running.id, status: "adjudicating" } });
    await db.update(caseRuns).set({ status: "cancelled" }).where(eq(caseRuns.id, running.id));
  });
});
