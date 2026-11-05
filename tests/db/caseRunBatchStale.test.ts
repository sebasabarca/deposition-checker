// Economy case runs (jobs/caseRunBatch.ts) whose evidence is corrected while their batches are at the provider
// (evidence/epoch.ts, migration 0039). Two things must hold together. Evidence: nothing computed from the old
// transcript is published (no new verdict or finding, no new submission). Accounting: every result the provider
// billed is recorded exactly once, every reservation ends settled, released (provably unbilled) or charged in full
// (uncertain), and every provider batch reaches a tracked end. A correction is simulated by moving evidence_epoch,
// which is what a committed correction does. Fake provider only: no key, no network, no paid call.

import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKET_MODEL } from "../../server/src/adjudicate/packetPrompt";
import type { PacketBatchProvider } from "../../server/src/adjudicate/packetBatch";
import type { Database } from "../../server/src/db/client";
import { budgets, caseRunBatches, caseRuns, depositions } from "../../server/src/db/schema";
import { FakeBatchProvider, type FakeBatchOptions } from "../../server/src/eval/mockPacketBatch";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunReport, caseRunSetOf, createCaseRun, runCaseRun, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { STALE_BATCH_RUN, type BatchSettings } from "../../server/src/jobs/caseRunBatch";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const SMALL: Partial<BatchSettings> = { batchSize: 4, inFlight: 3 };

describe.skipIf(!TEST_DATABASE_URL)("economy run whose evidence is corrected while its batches are pending", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  const clock = { t: Date.now() };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs cascade`);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  const corrected = () => db.update(depositions).set({ evidenceEpoch: sql`${depositions.evidenceEpoch} + 1` }).where(eq(depositions.caseId, caseId));
  const fake = (o: FakeBatchOptions = {}) => new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 1_000, now: () => clock.t, ...o });
  const deps = (provider: PacketBatchProvider, settings: Partial<BatchSettings> = SMALL): CaseRunDeps => ({
    adjudicator: () => { throw new Error("an economy run used the standard transport"); }, minilm: "off", sleep: async () => undefined,
    batch: () => ({ provider, settings, now: () => clock.t }),
  });
  // The provider, with a hook after the nth result it streams (a correction landing mid-import, or a crash).
  const hooked = (p: FakeBatchProvider, after: { n: number; run: () => Promise<void> } | null): PacketBatchProvider & { arm: (n: number, run: () => Promise<void>) => void } => {
    let hook = after;
    let seen = 0;
    return {
      submit: (r) => p.submit(r), retrieve: (id) => p.retrieve(id), cancel: (id) => p.cancel(id), list: (d) => p.list(d),
      async *results(id) {
        for await (const r of p.results(id)) {
          yield r;
          if (hook && ++seen === hook.n) { const h = hook; hook = null; await h.run(); }
        }
      },
      arm: (n, run) => { seen = 0; hook = { n, run }; },
    };
  };
  const status = async (id: number) => (await db.select({ s: caseRuns.status, e: caseRuns.error }).from(caseRuns).where(eq(caseRuns.id, id)))[0];
  const tick = (id: number, d: CaseRunDeps) => runCaseRun(db, pool, id, d);
  const until = async (id: number, d: CaseRunDeps, step = 1_000, max = 50) => {
    for (let i = 0; i < max; i++) {
      const out = await tick(id, d);
      if (out !== "polling") return out;
      await capCheck(id);
      clock.t += step;
    }
    throw new Error("still polling");
  };
  const budgetOf = async (id: number) => {
    const [r] = await db.select({ b: caseRuns.budgetId }).from(caseRuns).where(eq(caseRuns.id, id));
    return (await db.select().from(budgets).where(eq(budgets.id, r.b!)))[0];
  };
  const capCheck = async (id: number) => {
    const b = await budgetOf(id);
    expect(b.spentUsd + b.reservedUsd).toBeLessThanOrEqual(b.limitUsd + 1e-9);
  };
  // Every succeeded result the provider holds for this run's ended batches: what it billed.
  const billed = async (p: FakeBatchProvider) => {
    const ids = new Set<string>(); // a set: a result the provider delivers twice is billed once
    for (const b of p.batches.values()) {
      try { for await (const r of p.results(b.id)) if (r.type === "succeeded") ids.add(r.customId); } catch { /* not ended */ }
    }
    return [...ids].sort();
  };
  const recorded = async (id: number) => (await db.execute<{ custom_id: string }>(sql`select custom_id from adjudication_requests where candidate_set = ${caseRunSetOf(id)} and llm_call_id is not null`)).rows.map((r) => r.custom_id).sort();
  const llmRows = async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from llm_calls`)).rows[0].n;
  const recordedCost = async (id: number) => Number((await db.execute<{ c: string | null }>(sql`select coalesce(sum(l.cost_usd), 0)::text as c from adjudication_requests r join llm_calls l on l.id = r.llm_call_id where r.candidate_set = ${caseRunSetOf(id)}`)).rows[0].c);
  const uncertainMax = async (id: number) => Number((await db.execute<{ c: string }>(sql`select coalesce(sum(max_cost_usd), 0)::text as c from adjudication_requests where candidate_set = ${caseRunSetOf(id)} and error_kind = 'uncertain'`)).rows[0].c);
  const published = async (id: number) => (await db.execute<{ v: number; f: number }>(sql`
    select (select count(*) from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(id)})::int as v,
           (select count(*) from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(id)})::int as f`)).rows[0];
  const batchRows = async (id: number) => (await db.select({ s: caseRunBatches.status }).from(caseRunBatches).where(eq(caseRunBatches.caseRunId, id))).map((r) => r.s);
  const liveRun = (budgetUsd = 50) => createCaseRun(db, caseId, { mode: "live", budgetUsd, confirmed: true, execution: "batch" });

  // The invariants every scenario ends with.
  const settledExactlyOnce = async (id: number, p: FakeBatchProvider, rowsBefore: number) => {
    const b = await billed(p);
    expect(await recorded(id)).toEqual(b); // every billed result recorded, nothing else
    expect((await llmRows()) - rowsBefore).toBe(b.length); // and once
    const budget = await budgetOf(id);
    expect(budget.reservedUsd).toBeCloseTo(0, 9);
    expect(budget.spentUsd).toBeCloseTo((await recordedCost(id)) + (await uncertainMax(id)), 9);
    expect((await batchRows(id)).every((s) => ["imported", "not_submitted", "submission_unknown"].includes(s))).toBe(true);
    expect((await caseRunReport(db, id))!.requests.open).toBe(0);
    expect(Math.max(0, ...p.sentPerPacket.values())).toBeLessThanOrEqual(1); // nothing sent twice
  };

  it("results billed before the correction and imported after it are recorded once and not published", async () => {
    const p = fake();
    const run = await liveRun();
    const rows = await llmRows();
    expect(await tick(run.id, deps(p))).toBe("polling");
    const sent = p.batches.size;
    const before = await published(run.id);
    clock.t += 2_000; // the batches end, billed
    await corrected();
    expect(await until(run.id, deps(p))).toBe("failed");
    expect((await status(run.id)).e).toContain(STALE_BATCH_RUN);
    expect((await billed(p)).length).toBe(12);
    await settledExactlyOnce(run.id, p, rows);
    expect(await published(run.id)).toEqual(before);
    expect(p.batches.size).toBe(sent); // nothing new submitted
  }, 120_000);

  it("pending batches are cancelled; results that still finish after the cancel are recorded; the case is not blocked meanwhile", async () => {
    // Batches take a minute; a cancel takes 5 s to land, and the first request of each still completes (billed).
    const p = fake({ processingMs: 60_000, cancelMs: 5_000, completeOnCancel: 1 });
    const run = await liveRun();
    const rows = await llmRows();
    expect(await tick(run.id, deps(p))).toBe("polling");
    const before = await published(run.id);
    await corrected();
    expect(await tick(run.id, deps(p))).toBe("polling"); // cancel asked, batches still `canceling`
    expect((await status(run.id)).s).toBe("reconciling");
    expect([...p.batches.values()].every((b) => b.canceledAt !== null)).toBe(true);
    expect((await budgetOf(run.id)).reservedUsd).toBeGreaterThan(0); // held until the provider says what it billed
    // A new run of the same case starts and finishes while this one settles.
    const fresh = await createCaseRun(db, caseId, { mode: "mock" });
    expect(await runCaseRun(db, pool, fresh.id, { adjudicator: () => null, minilm: "off", sleep: async () => undefined })).toBe("completed");
    // Repeated checks while canceling change nothing and send nothing.
    expect(await tick(run.id, deps(p))).toBe("polling");
    expect(await tick(run.id, deps(p))).toBe("polling");
    clock.t += 6_000;
    expect(await until(run.id, deps(p))).toBe("failed");
    expect((await billed(p)).length).toBe(3); // one per batch
    await settledExactlyOnce(run.id, p, rows);
    expect(await published(run.id)).toEqual(before);
    // Cleanup repeated after the end changes nothing.
    expect(await tick(run.id, deps(p))).toBe("failed");
    await settledExactlyOnce(run.id, p, rows);
  }, 120_000);

  it("a correction landing mid-import: the database refuses the verdicts, never the cost records", async () => {
    const p = fake();
    const h = hooked(p, null);
    const run = await liveRun();
    const rows = await llmRows();
    expect(await tick(run.id, deps(h))).toBe("polling");
    const before = await published(run.id);
    clock.t += 2_000;
    h.arm(1, async () => { await corrected(); }); // committed right after the first result is recorded
    expect(await until(run.id, deps(h))).toBe("failed");
    expect((await billed(p)).length).toBe(12);
    await settledExactlyOnce(run.id, p, rows);
    expect(await published(run.id)).toEqual(before);
  }, 120_000);

  it("a retry is never sent from corrected evidence: the submit transaction checks the epochs before the provider is called", async () => {
    // Every first request errors (unbilled), so the next tick only retries: no other evidence-checked write.
    const p = fake({ outcome: (_r, n) => (n === 1 ? "errored" : {}) });
    const h = hooked(p, null);
    const run = await liveRun();
    const s = { batchSize: 4, inFlight: 1 };
    expect(await tick(run.id, deps(h, s))).toBe("polling");
    expect(p.batches.size).toBe(1);
    clock.t += 2_000;
    h.arm(1, async () => { await corrected(); });
    expect(await until(run.id, deps(h, s))).toBe("failed");
    expect(p.batches.size).toBe(1); // the retries were refused before submission
    const b = await budgetOf(run.id);
    expect(b.reservedUsd).toBeCloseTo(0, 9);
    expect(b.spentUsd).toBe(0);
  }, 120_000);

  it("provider unreachable, a crash mid-import and duplicate deliveries: each billed result recorded exactly once", async () => {
    let down = false;
    const p = fake({ duplicateResults: true, failRetrieve: () => down });
    const h = hooked(p, null);
    const run = await liveRun();
    const rows = await llmRows();
    expect(await tick(run.id, deps(h))).toBe("polling");
    const before = await published(run.id);
    clock.t += 2_000;
    await corrected();
    down = true;
    expect(await tick(run.id, deps(h))).toBe("polling");
    expect(await tick(run.id, deps(h))).toBe("polling");
    expect((await status(run.id)).s).toBe("reconciling"); // visibly waiting on the provider, nothing assumed
    expect((await db.select({ e: caseRunBatches.error }).from(caseRunBatches).where(eq(caseRunBatches.caseRunId, run.id))).every((r) => r.e?.startsWith("status check failed"))).toBe(true);
    expect(await recorded(run.id)).toEqual([]);
    down = false;
    // The worker dies after the third result is recorded; the next tick (a new worker) resumes the import.
    h.arm(3, async () => { throw new Error("worker killed"); });
    await expect(tick(run.id, deps(h))).rejects.toThrow("worker killed");
    await db.update(caseRuns).set({ runnerId: null }).where(eq(caseRuns.id, run.id)); // its claim lapses
    expect((await recorded(run.id)).length).toBeGreaterThanOrEqual(1);
    expect(await until(run.id, deps(h))).toBe("failed");
    await settledExactlyOnce(run.id, p, rows);
    expect(await published(run.id)).toEqual(before);
  }, 120_000);

  it("uncertain charges are kept in full and never resent: a missing result and a submission nobody can confirm", async () => {
    // Batch 2's submission is lost before the provider saw it; batch 1's first request has no result.
    let first: string | null = null;
    const p = fake({ onSubmit: (n) => (n === 2 ? "lost_unaccepted" : "ok"), outcome: (r) => { first ??= r.customId; return r.customId === first ? "omit" : {}; } });
    const run = await liveRun();
    const rows = await llmRows();
    const s = { batchSize: 4, inFlight: 2 };
    expect(await tick(run.id, deps(p, s))).toBe("polling");
    expect((await batchRows(run.id)).sort()).toEqual(["submitted", "submitting"]);
    clock.t += 2_000;
    await corrected();
    expect(await tick(run.id, deps(p, s))).toBe("polling"); // the unconfirmed submission waits out its window
    expect((await status(run.id)).s).toBe("reconciling");
    clock.t += 11 * 60_000;
    expect(await until(run.id, deps(p, s))).toBe("failed");
    expect((await batchRows(run.id)).sort()).toEqual(["imported", "submission_unknown"]);
    const report = (await caseRunReport(db, run.id))!;
    expect(report.requests.uncertain).toBe(5); // 1 missing result + 4 unconfirmed
    expect((await status(run.id)).e).toContain("5 requests with no result counted in full");
    await settledExactlyOnce(run.id, p, rows);
    expect(await uncertainMax(run.id)).toBeGreaterThan(0);
    expect(p.batches.size).toBe(1); // nothing resubmitted
  }, 120_000);

  it("a tight budget is never exceeded while a stale run settles", async () => {
    const p = fake({ processingMs: 60_000, cancelMs: 2_000, completeOnCancel: 2 });
    const run = await liveRun(1); // room for only a few worst-case reservations
    const rows = await llmRows();
    expect(await tick(run.id, deps(p))).toBe("polling");
    await capCheck(run.id);
    await corrected();
    expect(await until(run.id, deps(p))).toBe("failed");
    await settledExactlyOnce(run.id, p, rows);
    await capCheck(run.id);
  }, 120_000);

  it("a test-model economy run corrected mid-flight ends failed with nothing recorded or published", async () => {
    const p = fake();
    const run = await createCaseRun(db, caseId, { mode: "mock", execution: "batch" });
    const rows = await llmRows();
    expect(await tick(run.id, deps(p))).toBe("polling");
    const before = await published(run.id);
    await corrected();
    expect(await until(run.id, deps(p))).toBe("failed");
    expect(await llmRows()).toBe(rows);
    expect(await published(run.id)).toEqual(before);
    expect((await caseRunReport(db, run.id))!.requests.open).toBe(0);
  }, 120_000);

  it("a run with no correction is unaffected: it completes and publishes", async () => {
    const p = fake();
    const run = await liveRun();
    expect(await until(run.id, deps(p))).toBe("completed");
    expect((await published(run.id)).v).toBeGreaterThan(0);
    expect((await budgetOf(run.id)).reservedUsd).toBeCloseTo(0, 9);
  }, 120_000);
});

