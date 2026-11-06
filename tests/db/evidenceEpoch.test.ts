// Evidence versions (server/src/evidence/epoch.ts, migration 0039's guard): a result computed from a
// deposition's evidence is stored only while that evidence is still the version it was read from, whenever the
// write arrives. SYNTHETIC Webb fixture (invented testimony). No model call: a correction is simulated by moving
// evidence_epoch, which is what a committed correction does.
import { eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractFacts } from "../../server/src/claims/facts";
import { syncUnits } from "../../server/src/claims/facts/store";
import type { Database } from "../../server/src/db/client";
import { analyses, budgets, candidates, caseRuns, depositions, factUnits, findings, screeningEntries, verdicts } from "../../server/src/db/schema";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { captureEpochs, isStaleEvidence, jobEpochs, withEvidenceFence } from "../../server/src/evidence";
import { createCaseRun, runCaseRun } from "../../server/src/jobs";
import { STALE_CASE_RUN } from "../../server/src/jobs/caseRun";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("evidence versions on derived writes (Postgres, synthetic Webb)", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let witnessId: number;
  let depA: number;
  let depB: number;
  let cho: typeof candidates.$inferSelect;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs, fact_units, facts cascade`);
    const ids = await storeSynthetic(db, WEBB_SUITE);
    [cho] = await db.select().from(candidates).where(eq(candidates.id, ids.get("webb-cho")!));
    [depA, depB] = [cho.depositionA, cho.depositionB];
    ({ caseId, witnessId } = (await db.select().from(depositions).where(eq(depositions.id, depA)))[0]);
  });
  // What a committed correction does to the version (the correction itself is tested in evidenceCorrection.test.ts).
  const corrected = (dep: number) => db.update(depositions).set({ evidenceEpoch: sql`${depositions.evidenceEpoch} + 1` }).where(eq(depositions.id, dep));
  const outcome = (p: PromiseLike<unknown>) => Promise.resolve(p).then(() => "stored", (e) => (isStaleEvidence(e) ? "VE002" : String((e as { cause?: { message?: string } }).cause?.message ?? e)));
  let n = 0; // each row in its own set: the pair is unique within a set
  const candidateRow = (on: Database) => { const { id: _id, ...row } = cho; return on.insert(candidates).values({ ...row, candidateSet: `fence-test-${++n}` }); };
  const analysis = async () => {
    const [a] = await db.insert(analyses).values({ caseId, witnessId, depositionA: depA, depositionB: depB, mode: "demo", promptVersion: "adjudicate-v1", effort: "medium", maxCandidates: 300, budgetUsd: 1 }).returning();
    const [b] = await db.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: 1 }).returning();
    await db.update(analyses).set({ budgetId: b.id }).where(eq(analyses.id, a.id));
    return a.id;
  };
  const neverCalled = { liveAdjudicator: () => { throw new Error("a demo analysis asked for a model"); } };

  it("a fenced write is stored while the evidence is the version read, and refused once it changed or for a deposition not read", async () => {
    const epochs = await captureEpochs(db, [depA, depB]);
    expect(await outcome(withEvidenceFence(db, epochs, (f) => candidateRow(f)))).toBe("stored");
    await corrected(depA);
    expect(await outcome(withEvidenceFence(db, epochs, (f) => candidateRow(f)))).toBe("VE002");
    expect(await outcome(withEvidenceFence(db, { [String(depB)]: epochs[String(depB)] }, (f) => candidateRow(f)))).toBe("VE002"); // depA not read
    // After a hold has come and gone (a correction committed and released), the old version is still refused.
    await db.update(depositions).set({ evidenceHold: "correction-test" }).where(eq(depositions.id, depA));
    await db.update(depositions).set({ evidenceHold: null }).where(eq(depositions.id, depA));
    expect(await outcome(withEvidenceFence(db, epochs, (f) => candidateRow(f)))).toBe("VE002");
    // Re-read: the current version is accepted again.
    const now = await captureEpochs(db, [depA, depB]);
    expect(await outcome(withEvidenceFence(db, now, (f) => candidateRow(f)))).toBe("stored");
  });

  it("a case run keeps the versions it first read: its delayed results are refused after a correction", async () => {
    const run = await createCaseRun(db, caseId, { mode: "mock", budgetUsd: 0 });
    const ids = (await db.select({ id: depositions.id }).from(depositions).where(eq(depositions.caseId, caseId))).map((d) => d.id);
    await jobEpochs(db, "case_runs", run.id, null, ids);
    await corrected(depA);
    const deps = { adjudicator: () => null, sleep: async () => undefined, minilm: "off" as const };
    expect(await runCaseRun(db, pool, run.id, deps)).toBe("failed");
    expect((await db.select().from(caseRuns).where(eq(caseRuns.id, run.id)))[0]).toMatchObject({ status: "failed", error: STALE_CASE_RUN });
    expect(await db.$count(screeningEntries)).toBe(0);
  });

  it("fact extraction: a reading finished after a correction is refused, and nothing from it is saved", async () => {
    await syncUnits(db, depA);
    const reply = { stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } as never, text: "{}" };
    const model = { model: "claude-haiku-5-5", async extract() { await corrected(depA); return reply; } };
    await expect(extractFacts(db, depA, model, { maxBatches: 1 })).rejects.toSatisfy(isStaleEvidence);
    const [{ n }] = (await db.execute(sql`select coalesce(sum(attempts), 0)::int n from fact_units where deposition_id = ${depA}`)).rows as { n: number }[];
    expect(n).toBe(0);
  });

  it("writes that don't derive from read evidence are unaffected: a person's review", async () => {
    const [v] = await db.insert(verdicts).values({ candidateId: cho.id, model: "fixture", promptVersion: "x", effort: "low", status: "valid", parsed: {}, packet: {}, origin: "fixture" }).returning();
    const [f] = await db.insert(findings).values({ caseId, candidateId: cho.id, verdictId: v.id, type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", factors: [], caps: [], checks: {}, rubricVersion: "x", priority: "high" }).returning();
    await corrected(depA);
    expect(await outcome(db.update(findings).set({ reviewState: "confirmed" }).where(inArray(findings.id, [f.id])))).toBe("stored");
    expect(await db.$count(factUnits)).toBe(0);
  });
});
