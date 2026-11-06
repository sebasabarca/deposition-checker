// Worker coordination for evidence corrections (server/src/evidence/correction.ts, migration 0039). While a
// deposition's evidence is held, the database refuses every write to it and its derived rows (except the
// holder's), and analysis and case-run jobs wait instead of reading it. A hold is refused while work on the case
// is unfinished. SYNTHETIC Webb fixture (invented testimony). No model call.
import { and, eq, or, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { analyses, budgets, candidates, caseRuns, depositions, evidenceMigrations, exchanges, findings, verdicts } from "../../server/src/db/schema";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { ANALYSIS_DONE, applyCorrection, CASE_RUN_DONE, isEvidenceOnHold } from "../../server/src/evidence";
import { CASE_RUN_TERMINAL, createCaseRun, runCaseRun } from "../../server/src/jobs";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("evidence holds and workers (Postgres, synthetic Webb)", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let depA: number;
  let depB: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs cascade`);
    const ids = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, ids.get("webb-cho")!));
    [depA, depB, caseId] = [c.depositionA, c.depositionB, (await db.select().from(depositions).where(eq(depositions.id, c.depositionA)))[0].caseId];
  });
  const hold = (dep: number, id: string | null) => db.update(depositions).set({ evidenceHold: id }).where(eq(depositions.id, dep));
  const refusal = async (p: PromiseLike<unknown>) => { try { await p; return "accepted"; } catch (e) { return isEvidenceOnHold(e) ? "VE001" : String(e); } };
  const analysis = async () => {
    const [a] = await db.insert(analyses).values({ caseId, witnessId: (await db.select().from(depositions).where(eq(depositions.id, depA)))[0].witnessId, depositionA: depA, depositionB: depB, mode: "demo", promptVersion: "adjudicate-v1", effort: "medium", maxCandidates: 300, budgetUsd: 1 }).returning();
    const [b] = await db.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: 1 }).returning();
    await db.update(analyses).set({ budgetId: b.id }).where(eq(analyses.id, a.id));
    return a.id;
  };
  const neverCalled = { liveAdjudicator: () => { throw new Error("a demo analysis asked for a model"); } };

  it("the finished-state lists the correction checks are the jobs' own", () => {
    expect(CASE_RUN_DONE).toEqual(CASE_RUN_TERMINAL);
  });

  it("while held, the database refuses every write to the deposition's evidence and derived rows, except the holder's", async () => {
    const [x] = await db.select().from(exchanges).where(eq(exchanges.depositionId, depA)).limit(1);
    const [y] = await db.select().from(exchanges).where(eq(exchanges.depositionId, depB)).limit(1);
    const [c] = await db.select().from(candidates).where(or(eq(candidates.depositionA, depA), eq(candidates.depositionB, depA))).limit(1);
    const [v] = await db.insert(verdicts).values({ candidateId: c.id, model: "fixture", promptVersion: "x", effort: "low", status: "valid", parsed: {}, packet: {}, origin: "fixture" }).returning();
    const [{ id: onA }] = await db.insert(findings).values({ caseId, candidateId: c.id, verdictId: v.id, type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", factors: [], caps: [], checks: {}, rubricVersion: "x", priority: "high" }).returning();
    await hold(depA, "correction-test");
    expect(await refusal(db.update(exchanges).set({ flags: ["x"] }).where(eq(exchanges.id, x.id)))).toBe("VE001");
    expect(await refusal(db.update(findings).set({ reviewNote: "late" }).where(eq(findings.id, onA)))).toBe("VE001"); // a review, through its candidate
    expect(await refusal(db.delete(candidates).where(or(eq(candidates.depositionA, depA), eq(candidates.depositionB, depA))))).toBe("VE001");
    expect(await refusal(db.delete(depositions).where(eq(depositions.id, depA)))).toBe("VE001"); // its rows cascade, and are guarded
    expect(await refusal(db.update(depositions).set({ status: "processing" }).where(eq(depositions.id, depA)))).toBe("VE001"); // a re-read can't start
    expect(await refusal(db.update(exchanges).set({ flags: [] }).where(eq(exchanges.id, y.id)))).toBe("accepted"); // another deposition
    // The holder's own transaction may write.
    expect(await refusal(db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('evidence.migration', 'correction-test', true)`);
      await tx.update(exchanges).set({ flags: ["x"] }).where(eq(exchanges.id, x.id));
    }))).toBe("accepted");
    await hold(depA, null);
    expect(await refusal(db.update(findings).set({ reviewNote: "now" }).where(eq(findings.id, onA)))).toBe("accepted");
  });

  it("a case run waits while any deposition of its case is held, then runs", async () => {
    const run = await createCaseRun(db, caseId, { mode: "mock", budgetUsd: 0 });
    const deps = { adjudicator: () => null, sleep: async () => undefined, minilm: "off" as const };
    await hold(depA, "correction-test");
    expect(await runCaseRun(db, pool, run.id, deps)).toBe("polling");
    expect((await db.select().from(caseRuns).where(eq(caseRuns.id, run.id)))[0].status).toBe("queued");
    await hold(depA, null);
    expect(await runCaseRun(db, pool, run.id, deps)).toBe("completed");
  });

  it("a hold is refused while an analysis or a case run of the case is unfinished", async () => {
    const opts = { backupDir: "data/raw/unused", planHash: "x", expect: { lines: [] } };
    const id = await analysis(); // queued
    expect(await applyCorrection(db, depA, opts)).toMatchObject({ outcome: "busy", detail: expect.stringContaining("1 analyses") });
    await db.update(analyses).set({ status: "cancelled" }).where(eq(analyses.id, id));
    const run = await createCaseRun(db, caseId, { mode: "mock", budgetUsd: 0 });
    expect(await applyCorrection(db, depA, opts)).toMatchObject({ outcome: "busy", detail: expect.stringContaining("1 case runs") });
    expect(await db.$count(evidenceMigrations)).toBe(0);
    expect((await db.select().from(depositions).where(eq(depositions.id, depA)))[0].evidenceHold).toBeNull();
    // Once the work is finished the hold is taken; this correction can't proceed (no stored file, wrong plan
    // hash), so the hold is released again and the ledger says so.
    await db.update(caseRuns).set({ status: "cancelled" }).where(eq(caseRuns.id, run.id));
    expect((await applyCorrection(db, depA, opts)).outcome).not.toBe("busy");
    expect(await db.select({ status: evidenceMigrations.status }).from(evidenceMigrations).where(and(eq(evidenceMigrations.depositionId, depA)))).toEqual([{ status: "abandoned" }]);
    expect((await db.select().from(depositions).where(eq(depositions.id, depA)))[0].evidenceHold).toBeNull();
  });
});
