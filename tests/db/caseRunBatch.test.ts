// Economy case runs (jobs/caseRunBatch.ts) against the fake Message Batches API (eval/mockPacketBatch.ts): the
// same verdicts, findings, scores and coverage as standard execution, at half the recorded cost, and safe through
// out-of-order and duplicate results, errors, expiry, missing results, lost submissions, crashes, cancellation
// and a tight budget. Every tick is a fresh call, as after a worker restart. No API key, no network.

import { and, eq, sql } from "drizzle-orm";
import express from "express";
import type { PgBoss } from "pg-boss";
import { caseRunRoutes } from "../../server/src/api";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKET_MODEL, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import type { Database } from "../../server/src/db/client";
import { budgets, candidates, caseRunBatches, caseRuns, depositions, findings, llmCalls, screeningEntries, verdicts } from "../../server/src/db/schema";
import { FakeBatchProvider, type FakeBatchOptions } from "../../server/src/eval/mockPacketBatch";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunFindings, caseRunReport, caseRunSetOf, confirmCaseRun, createCaseRun, mockCaseModel, resumeCaseRun, runCaseRun, type CasePacketModel, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import type { BatchSettings } from "../../server/src/jobs/caseRunBatch";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const SMALL: Partial<BatchSettings> = { batchSize: 4, inFlight: 3 };

describe.skipIf(!TEST_DATABASE_URL)("whole-case run, economy (batch) execution", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let mockBaseline: number;
  let liveBaseline: number;
  const clock = { t: Date.now() };

  const fingerprint = async (runId: number) => {
    const rows = await db
      .select({ a: candidates.depositionA, ga: candidates.groupA, b: candidates.depositionB, gb: candidates.groupB, parsed: verdicts.parsed, type: findings.type, score: findings.score, band: findings.band, status: findings.evidenceStatus, priority: findings.priority })
      .from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).leftJoin(findings, eq(findings.verdictId, verdicts.id))
      .where(eq(candidates.candidateSet, caseRunSetOf(runId)));
    return rows.map((r) => `${r.a}:${r.ga}|${r.b}:${r.gb} ${JSON.stringify([r.parsed, r.type, r.score, r.band, r.status, r.priority])}`).sort();
  };
  const duplicates = async (runId: number) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from (select v.candidate_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(runId)} group by 1 having count(*) > 1) d`)).rows[0].n;
  const accounting = async (runId: number) => {
    const r = (await caseRunReport(db, runId))!;
    const { sameWitness, crossWitness, ...c } = r.candidates;
    return { candidates: c, sameWitness, crossWitness, packets: r.packets.total, coverage: r.coverageState };
  };
  const budgetOf = async (runId: number) => {
    const [run] = await db.select({ budgetId: caseRuns.budgetId }).from(caseRuns).where(eq(caseRuns.id, runId));
    return (await db.select().from(budgets).where(eq(budgets.id, run.budgetId!)))[0];
  };
  const order = (f: Awaited<ReturnType<typeof caseRunFindings>>) => f.map((x) => `${x.a.exchange}|${x.b.exchange}|${x.type}|${x.score}`);
  const batchCalls = async (runId: number) => (await db.execute<{ n: number; cost: string | null }>(sql`select count(*)::int as n, sum(l.cost_usd)::text as cost from adjudication_requests r join llm_calls l on l.id = r.llm_call_id where r.candidate_set = ${caseRunSetOf(runId)} and l.batch`)).rows[0];

  const fake = (o: FakeBatchOptions = {}) => new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 1_000, now: () => clock.t, ...o });
  const standardThrows: CasePacketModel = { model: PACKET_MODEL, effort: "medium", promptVersion: "packet-v1", adjudicate: async () => { throw new Error("an economy run used the standard transport"); } };
  const batchDeps = (provider: FakeBatchProvider, settings: Partial<BatchSettings> = SMALL, faults?: NonNullable<ReturnType<NonNullable<CaseRunDeps["batch"]>>>["faults"]): CaseRunDeps => ({
    adjudicator: () => standardThrows, minilm: "off", sleep: async () => undefined,
    batch: () => ({ provider, settings, now: () => clock.t, faults }),
  });
  // Runs ticks until the run stops polling, moving the clock so batches end. Each tick is a new call.
  const drive = async (runId: number, deps: CaseRunDeps, { step = 1_000, max = 300, onTick }: { step?: number; max?: number; onTick?: (i: number) => Promise<void> } = {}) => {
    for (let i = 0; i < max; i++) {
      const out = await runCaseRun(db, pool, runId, deps);
      if (out !== "polling") return out;
      await onTick?.(i);
      clock.t += step;
    }
    throw new Error("still polling");
  };
  const liveRun = (budgetUsd = 50) => createCaseRun(db, caseId, { mode: "live", budgetUsd, confirmed: true, execution: "batch" });

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
    const plain = { adjudicator: () => null, minilm: "off" as const, sleep: async () => undefined };
    mockBaseline = (await createCaseRun(db, caseId, { mode: "mock" })).id;
    expect(await runCaseRun(db, pool, mockBaseline, plain)).toBe("completed");
    // Standard live execution with the same mock replies, priced as Sonnet: the cost baseline.
    const m = mockCaseModel(PACKET_MODEL);
    liveBaseline = (await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true })).id;
    expect(await runCaseRun(db, pool, liveBaseline, { ...plain, adjudicator: () => ({ ...m, effort: "medium" }) })).toBe("completed");
  }, 180_000);
  afterAll(async () => { await pool?.end(); });

  it("a test-model economy run gives exactly the standard run's verdicts, findings, scores, priorities and coverage, over several batches", async () => {
    const p = fake();
    const run = await createCaseRun(db, caseId, { mode: "mock", execution: "batch" });
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(mockBaseline));
    expect(await accounting(run.id)).toEqual(await accounting(mockBaseline));
    expect(order(await caseRunFindings(db, run.id))).toEqual(order(await caseRunFindings(db, mockBaseline)));
    expect(await duplicates(run.id)).toBe(0);
    const report = (await caseRunReport(db, run.id))!;
    expect(report.execution).toBe("batch");
    expect(report.batches!.total).toBeGreaterThan(1);
    expect(report.batches!.imported).toBe(report.batches!.total);
    expect(Math.max(...[...p.sentPerPacket.values()])).toBe(1); // every packet submitted once
    expect((await batchCalls(run.id)).n).toBe(0);
  }, 120_000);

  it("a live economy run matches standard execution and records every reply at half the price, with nothing left reserved", async () => {
    const p = fake();
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    expect(await accounting(run.id)).toEqual(await accounting(liveBaseline));
    const batch = await batchCalls(run.id);
    const standard = (await caseRunReport(db, liveBaseline))!.cost;
    expect(batch.n).toBe(standard.recordedCalls);
    expect(Number(batch.cost)).toBeCloseTo(standard.costUsd / 2, 6);
    const b = await budgetOf(run.id);
    expect(b.reservedUsd).toBe(0);
    expect(b.spentUsd).toBeCloseTo(Number(batch.cost), 6);
    const report = (await caseRunReport(db, run.id))!;
    expect(report.requests).toMatchObject({ uncertain: 0, open: 0 });
    // Results arrived in reverse order; findings are still listed in retrieval order.
    expect(order(await caseRunFindings(db, run.id))).toEqual(order(await caseRunFindings(db, liveBaseline)));
  }, 120_000);

  it("imports a result delivered twice only once", async () => {
    const run = await liveRun();
    const callsBefore = await db.$count(llmCalls);
    expect(await drive(run.id, batchDeps(fake({ duplicateResults: true })))).toBe("completed");
    expect((await db.$count(llmCalls)) - callsBefore).toBe((await caseRunReport(db, liveBaseline))!.cost.recordedCalls); // one llm_calls row per reply
    expect(await duplicates(run.id)).toBe(0);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    expect((await batchCalls(run.id)).n).toBe((await caseRunReport(db, liveBaseline))!.cost.recordedCalls);
  }, 120_000);

  it("sends unanswered pairs once more as a recovery request in a later batch, as standard execution does", async () => {
    // The first submission of each packet leaves its first pair unanswered.
    const p = fake({ outcome: (r, n) => (n === 1 && r.packet.pairs.length > 1 ? { drop: [r.packet.pairs[0].pairId] } : {}) });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    const rounds = await db.execute<{ round: number; n: number }>(sql`select round, count(*)::int as n from adjudication_requests where candidate_set = ${caseRunSetOf(run.id)} group by 1 order by 1`);
    expect(rounds.rows.map((r) => r.round)).toEqual([1, 2]);
    // A pair still unanswered after its recovery request stays unread: the entry is incomplete, never compatible.
    const q = fake({ outcome: (r) => ({ drop: [r.packet.pairs[0].pairId] }) });
    const stuck = await liveRun();
    expect(await drive(stuck.id, batchDeps(q))).toBe("incomplete");
    const report = (await caseRunReport(db, stuck.id))!;
    expect(report.coverageState).toBe("partial");
    expect(report.candidates.incomplete).toBeGreaterThan(0);
    expect(Math.max(...[...q.sentPerPacket.values()])).toBe(2);
  }, 120_000);

  it("retries an errored or expired request once (not billed), and leaves it failed and unread after that", async () => {
    const flaky = fake({ outcome: (_r, n) => (n === 1 ? "errored" : {}) });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(flaky))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    expect((await budgetOf(run.id)).reservedUsd).toBe(0);

    const expiring = fake({ outcome: () => "expired" });
    const lost = await liveRun();
    expect(await drive(lost.id, batchDeps(expiring))).toBe("incomplete");
    const r = (await caseRunReport(db, lost.id))!;
    expect(r.candidates.adjudicated).toBe(0);
    expect(r.packets.failed).toBe(r.packets.total);
    expect(r.packets.uncertain).toBe(0); // expired requests are not billed
    expect(Math.max(...[...expiring.sentPerPacket.values()])).toBe(2);
    const b = await budgetOf(lost.id);
    expect(b.spentUsd).toBe(0);
    expect(b.reservedUsd).toBe(0);
    expect(await db.$count(findings, sql`${findings.candidateId} in (select id from candidates where candidate_set = ${caseRunSetOf(lost.id)})`)).toBe(0);

    // A request the provider rejects as invalid is not retried.
    const invalid = fake({ outcome: () => "invalid" });
    const bad = await liveRun();
    expect(await drive(bad.id, batchDeps(invalid))).toBe("incomplete");
    expect(Math.max(...[...invalid.sentPerPacket.values()])).toBe(1);
  }, 120_000);

  it("counts a request with no result in an ended batch as possibly billed, and resends it only with retryUncertain", async () => {
    let omit = true;
    const p = fake({ outcome: (r) => (omit && r.packet.id.endsWith("1") ? "omit" : {}) });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(p))).toBe("incomplete");
    const before = (await caseRunReport(db, run.id))!;
    expect(before.packets.uncertain).toBeGreaterThan(0);
    expect(before.requests.uncertain).toBe(before.packets.uncertain);
    const sent = new Map(p.sentPerPacket);
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await drive(run.id, batchDeps(p))).toBe("incomplete"); // nothing resent without retryUncertain
    expect(p.sentPerPacket).toEqual(sent);
    omit = false;
    expect(await resumeCaseRun(db, run.id, { retryUncertain: true })).toBe("queued");
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    expect((await budgetOf(run.id)).reservedUsd).toBe(0);
  }, 120_000);

  it("adopts a batch the provider accepted when the worker lost the reply, without submitting it again", async () => {
    const p = fake({ onSubmit: (n) => (n === 2 ? "lost_accepted" : "ok") });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(Math.max(...[...p.sentPerPacket.values()])).toBe(1);
    const [recovered] = await db.select().from(caseRunBatches).where(and(eq(caseRunBatches.caseRunId, run.id), sql`${caseRunBatches.recovery} is not null`));
    expect(recovered.recovery).toMatch(/Recovered after a crash during submission: .* carry exactly this batch's \d+ custom IDs/);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
  }, 120_000);

  it("adopts a lost batch only on its custom IDs: a same-size batch is never taken as proof, and nothing is resubmitted", async () => {
    // The first submission is accepted but its reply is lost, and it takes a long time; a batch of the same size
    // from somewhere else (another run, another environment) appears in the list at the same moment.
    const p = fake({ processingMs: 30 * 60_000, onSubmit: (n) => (n === 1 ? "lost_accepted" : "ok") });
    const run = await liveRun();
    expect(await runCaseRun(db, pool, run.id, batchDeps(p))).toBe("polling");
    const [row] = await db.select().from(caseRunBatches).where(and(eq(caseRunBatches.caseRunId, run.id), eq(caseRunBatches.seq, 1)));
    expect(row.status).toBe("submitting");
    const lost = [...p.batches.values()][0];
    await p.submit(lost.requests.map((r, i) => ({ customId: `other-${i}`, packet: r.packet }))); // the decoy: same size, other IDs
    const submissions = p.submissions;
    // While both are processing, nothing can be proven: the row waits, past the 10-minute window, and nothing is resent.
    for (let i = 0; i < 2; i++) { clock.t += 12 * 60_000; expect(await runCaseRun(db, pool, run.id, batchDeps(p))).toBe("polling"); }
    const [waiting] = await db.select().from(caseRunBatches).where(eq(caseRunBatches.id, row.id));
    expect(waiting.status).toBe("submitting");
    expect(waiting.error).toMatch(/2 provider batches of the same size still processing/);
    expect([...lost.requests].every((r) => p.sentPerPacket.get(r.packet.id) === 2)).toBe(true); // ours and the decoy only
    // Once they end, the custom IDs decide: ours is adopted, the decoy is not.
    expect(await drive(run.id, batchDeps(p), { step: 60_000 })).toBe("completed");
    const [adopted] = await db.select().from(caseRunBatches).where(eq(caseRunBatches.id, row.id));
    expect(adopted.providerBatchId).toBe(lost.id);
    expect(p.submissions - submissions).toBeGreaterThan(0); // later batches only
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
  }, 120_000);

  it("never adopts a same-size batch with other custom IDs: the submission stays unknown for a person to resolve", async () => {
    const p = fake({ onSubmit: (n) => (n === 1 ? "lost_unaccepted" : "ok") });
    const run = await liveRun();
    expect(await runCaseRun(db, pool, run.id, batchDeps(p))).toBe("polling");
    const [row] = await db.select().from(caseRunBatches).where(and(eq(caseRunBatches.caseRunId, run.id), eq(caseRunBatches.seq, 1)));
    const reqs = await db.execute<{ n: number }>(sql`select count(*)::int as n from adjudication_requests where case_run_batch_id = ${row.id}`);
    const packets = (await db.select().from(screeningEntries).where(sql`${screeningEntries.id} in (select screening_entry_id from adjudication_requests where case_run_batch_id = ${row.id})`)).length;
    expect(packets).toBe(reqs.rows[0].n);
    // A decoy of exactly the same size, created after the row, ends at once.
    const decoy = { id: "decoy", passages: [], pairs: [] } as unknown as IssuePacket;
    await p.submit(Array.from({ length: row.requestCount }, (_, i) => ({ customId: `decoy-${i}`, packet: decoy })));
    expect(await drive(run.id, batchDeps(p), { step: 60_000 })).toBe("incomplete");
    const [after] = await db.select().from(caseRunBatches).where(eq(caseRunBatches.id, row.id));
    expect(after.status).toBe("submission_unknown");
    expect(after.providerBatchId).toBeNull();
  }, 120_000);

  it("re-queues a test-model run's batches lost with a worker restart, and finishes with the same findings", async () => {
    const before = fake({ processingMs: 60_000 });
    const run = await createCaseRun(db, caseId, { mode: "mock", execution: "batch" });
    expect(await runCaseRun(db, pool, run.id, batchDeps(before))).toBe("polling");
    // The worker restarts: its in-memory fake provider (and every batch in it) is gone.
    expect(await drive(run.id, batchDeps(fake()))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(mockBaseline));
    expect(await duplicates(run.id)).toBe(0);
    expect((await caseRunReport(db, run.id))!.requests.uncertain).toBe(0);
    // A live run's vanished batch stays uncertain: it may have run and been billed.
    const gone = fake({ processingMs: 60_000 });
    const live = await liveRun();
    expect(await runCaseRun(db, pool, live.id, batchDeps(gone))).toBe("polling");
    expect(await drive(live.id, batchDeps(fake()))).toBe("incomplete");
    expect((await caseRunReport(db, live.id))!.packets.uncertain).toBeGreaterThan(0);
  }, 120_000);

  it("keeps spending plus reservations within the limit through expiry, retries, an uncertain submission and a cancel", async () => {
    const limit = 0.8;
    const watch = (runId: number, seen: { worst: number }) => async () => { const b = await budgetOf(runId); seen.worst = Math.max(seen.worst, b.spentUsd + b.reservedUsd); };
    // Expired first sends (retried once, unbilled), long replies, and one submission whose outcome is unknown.
    const p = fake({ outputPerPair: 4000, outcome: (_r, n) => (n === 1 ? "expired" : {}), onSubmit: (n) => (n === 2 ? "lost_unaccepted" : "ok") });
    const run = await liveRun(limit);
    const seen = { worst: 0 };
    const out = await drive(run.id, batchDeps(p, { batchSize: 5, inFlight: 4 }), { step: 60_000, onTick: watch(run.id, seen) });
    expect(["blocked_budget", "incomplete"]).toContain(out);
    expect(seen.worst).toBeLessThanOrEqual(limit + 1e-9);
    const b = await budgetOf(run.id);
    expect(b.spentUsd).toBeLessThanOrEqual(limit + 1e-9);
    expect(b.reservedUsd).toBe(0);
    // The recorded calls never cost more than what was charged against the limit.
    expect((await caseRunReport(db, run.id))!.cost.costUsd).toBeLessThanOrEqual(b.spentUsd + 1e-9);
    // A cancel releases what didn't run and settles what did, without passing the limit.
    const q = fake({ processingMs: 10 * 60_000, completeOnCancel: 2, outputPerPair: 4000 });
    const cancelled = await liveRun(limit);
    const seen2 = { worst: 0 };
    expect(await drive(cancelled.id, batchDeps(q, { batchSize: 5, inFlight: 4 }), {
      onTick: async (i) => { await watch(cancelled.id, seen2)(); if (i === 0) await db.update(caseRuns).set({ cancelRequestedAt: new Date() }).where(eq(caseRuns.id, cancelled.id)); },
    })).toBe("cancelled");
    expect(seen2.worst).toBeLessThanOrEqual(limit + 1e-9);
    expect((await budgetOf(cancelled.id)).reservedUsd).toBe(0);
  }, 120_000);

  it("never resubmits a batch whose submission can't be confirmed: it waits, then needs a decision", async () => {
    // Lost before the provider got it, and the worker died before learning that: from the database alone the
    // outcome is unknown. A crash between writing the rows and calling the provider looks the same.
    const p = fake({ onSubmit: (n) => (n === 1 ? "lost_unaccepted" : "ok") });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(p), { step: 60_000 })).toBe("incomplete");
    const [unknown] = await db.select().from(caseRunBatches).where(and(eq(caseRunBatches.caseRunId, run.id), eq(caseRunBatches.status, "submission_unknown")));
    expect(unknown).toBeDefined();
    const report = (await caseRunReport(db, run.id))!;
    expect(report.packets.uncertain).toBe(unknown.requestCount);
    expect(report.incompleteReasons.join(" ")).toMatch(/could not be confirmed/);
    const b = await budgetOf(run.id);
    expect(b.spentUsd).toBeGreaterThanOrEqual(unknown.maxCostUsd - 1e-6); // counted in full
    expect(b.reservedUsd).toBe(0);
    expect(await resumeCaseRun(db, run.id, { retryUncertain: true })).toBe("queued");
    expect(await drive(run.id, batchDeps(p))).toBe("completed");

    const crashed = await liveRun();
    const q = fake();
    await expect(runCaseRun(db, pool, crashed.id, batchDeps(q, SMALL, { afterBatchWritten: (seq) => { if (seq === 1) throw new Error("worker killed"); } }))).rejects.toThrow("worker killed");
    expect(q.submissions).toBe(0);
    expect(await drive(crashed.id, batchDeps(q), { step: 60_000 })).toBe("incomplete");
    expect(Math.max(0, ...[...q.sentPerPacket.values()])).toBe(1);
  }, 120_000);

  it("survives a crash in the middle of importing results: no duplicate verdicts or charges", async () => {
    const p = fake();
    const run = await liveRun();
    let crashes = 0;
    const deps = batchDeps(p, SMALL, { afterResultRecorded: () => { if (++crashes === 3) throw new Error("worker killed mid-import"); } });
    await expect(drive(run.id, deps)).rejects.toThrow("worker killed mid-import");
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await duplicates(run.id)).toBe(0);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    expect((await batchCalls(run.id)).n).toBe((await caseRunReport(db, liveBaseline))!.cost.recordedCalls);
    expect((await budgetOf(run.id)).reservedUsd).toBe(0);
  }, 120_000);

  it("cancels at the provider, keeps what finished, returns the rest to the queue, and can be resumed", async () => {
    const p = fake({ processingMs: 10_000, completeOnCancel: 1 });
    const run = await liveRun();
    const out = await drive(run.id, batchDeps(p), {
      onTick: async (i) => { if (i === 0) await db.update(caseRuns).set({ cancelRequestedAt: new Date() }).where(eq(caseRuns.id, run.id)); },
    });
    expect(out).toBe("cancelled");
    const report = (await caseRunReport(db, run.id))!;
    expect(report.candidates.adjudicated).toBeGreaterThan(0); // the request that finished despite the cancel
    expect(report.packets.notStarted).toBeGreaterThan(0);
    expect(report.requests.uncertain).toBe(0);
    expect((await budgetOf(run.id)).reservedUsd).toBe(0);
    expect(await db.$count(caseRunBatches, and(eq(caseRunBatches.caseRunId, run.id), sql`${caseRunBatches.cancelRequestedAt} is not null`))).toBeGreaterThan(0);
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await drive(run.id, batchDeps(fake()))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
    expect(await duplicates(run.id)).toBe(0);
  }, 120_000);

  it("never lets reservations and spending pass the budget, and stops only when nothing is in flight", async () => {
    const p = fake({ outputPerPair: 4000 });
    const run = await liveRun(0.6);
    let worst = 0;
    const out = await drive(run.id, batchDeps(p, { batchSize: 50, inFlight: 5 }), {
      onTick: async () => { const b = await budgetOf(run.id); worst = Math.max(worst, b.spentUsd + b.reservedUsd); },
    });
    expect(out).toBe("blocked_budget");
    expect(worst).toBeLessThanOrEqual(0.6 + 1e-9);
    const b = await budgetOf(run.id);
    expect(b.reservedUsd).toBe(0);
    expect(b.spentUsd).toBeLessThanOrEqual(0.6);
    expect(await resumeCaseRun(db, run.id, { budgetUsd: 50 })).toBe("queued");
    expect(await drive(run.id, batchDeps(p, { batchSize: 50, inFlight: 5 }))).toBe("completed");
    expect(Math.max(...[...p.sentPerPacket.values()])).toBe(1);
  }, 120_000);

  it("retries a batch the provider rate-limited, and fails the run on a batch it refuses as invalid, charging nothing", async () => {
    const limited = fake({ onSubmit: (n) => (n <= 2 ? "rate_limited" : "ok") });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(limited))).toBe("completed");
    expect(await db.$count(caseRunBatches, and(eq(caseRunBatches.caseRunId, run.id), eq(caseRunBatches.status, "not_submitted")))).toBe(2);
    expect((await caseRunReport(db, run.id))!.requests.uncertain).toBe(0);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));

    const refused = await liveRun();
    expect(await drive(refused.id, batchDeps(fake({ onSubmit: () => "invalid" })))).toBe("failed");
    const b = await budgetOf(refused.id);
    expect(b.spentUsd).toBe(0);
    expect(b.reservedUsd).toBe(0);
  }, 120_000);

  it("keeps polling through failed status checks", async () => {
    const p = fake({ failRetrieve: (n) => n % 2 === 1 });
    const run = await liveRun();
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(liveBaseline));
  }, 120_000);

  it("needs the retention acknowledgement to confirm economy, and estimates both modes from the same packets", async () => {
    const run = await createCaseRun(db, caseId, { mode: "live" });
    expect(await runCaseRun(db, pool, run.id, batchDeps(fake()))).toBe("awaiting_confirmation");
    const estimate = (await caseRunReport(db, run.id))!.estimate as { expectedUsd: number; noCacheUsd: number; economy: { expectedUsd: number; noCacheUsd: number; recommendedBudgetUsd: number; worstCaseUsd: number } };
    expect(estimate.economy.expectedUsd).toBeCloseTo(estimate.expectedUsd / 2, 1);
    expect(estimate.economy.noCacheUsd).toBeCloseTo(estimate.noCacheUsd / 2, 1);
    expect(estimate.economy.recommendedBudgetUsd).toBeGreaterThan(estimate.economy.noCacheUsd);
    expect(await confirmCaseRun(db, run.id, { budgetUsd: 5, execution: "batch" })).toBe("no_acknowledgement");
    expect(await confirmCaseRun(db, run.id, { budgetUsd: 5, execution: "batch", retentionAcknowledged: true })).toBe("queued");
    const [row] = await db.select().from(caseRuns).where(eq(caseRuns.id, run.id));
    expect(row.execution).toBe("batch");
    expect(row.retentionAcknowledgedAt).not.toBeNull();
    expect(await drive(run.id, batchDeps(fake()))).toBe("completed");
    // A run confirmed without a mode stays standard.
    const plain = await createCaseRun(db, caseId, { mode: "live" });
    await runCaseRun(db, pool, plain.id, batchDeps(fake()));
    expect(await confirmCaseRun(db, plain.id, { budgetUsd: 5 })).toBe("queued");
    expect((await db.select().from(caseRuns).where(eq(caseRuns.id, plain.id)))[0].execution).toBe("standard");
    await db.update(caseRuns).set({ status: "cancelled" }).where(eq(caseRuns.id, plain.id)); // not run: leaves the case free
  }, 120_000);

  it("takes the mode and the acknowledgement over the API, and cancels a run between checks through its next check", async () => {
    const sent: unknown[] = [];
    const boss = { send: async (_q: string, data: unknown) => { sent.push(data); return null; } } as unknown as PgBoss;
    const app = express();
    app.use(express.json());
    let env: Record<string, string> = { ALLOW_ECONOMY_ANALYSIS: "true", ALLOW_TEST_RUNS: "true" };
    app.use("/api", (req, res, next) => caseRunRoutes({ db, boss, env })(req, res, next));
    const server = await listen(app);
    const post = (path: string, body: unknown) => fetch(`${server.url}/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const mock = await post(`/cases/${caseId}/case-runs`, { mode: "mock", execution: "batch" });
      expect(mock.status).toBe(202);
      const mockRun = (await mock.json()).caseRun;
      expect(mockRun.execution).toBe("batch");
      expect(await drive(mockRun.id, batchDeps(fake()))).toBe("completed");
      expect((await post(`/cases/${caseId}/case-runs`, { mode: "mock", execution: "overnight" })).status).toBe(400);

      const live = (await (await post(`/cases/${caseId}/case-runs`, { mode: "live" })).json()).caseRun;
      expect(await runCaseRun(db, pool, live.id, batchDeps(fake()))).toBe("awaiting_confirmation");
      // Without the server's API key neither mode can be confirmed, and the report says so; the flags aren't read.
      env = { ALLOW_PAID_CALLS: "true", ALLOW_ECONOMY_ANALYSIS: "true" };
      for (const execution of ["standard", "batch"]) {
        const off = await post(`/case-runs/${live.id}/confirm`, { budgetUsd: 5, execution, retentionAcknowledged: true });
        expect(off.status).toBe(409);
        expect((await off.json()).code).toBe("paid_unavailable");
      }
      const report = async () => (await (await fetch(`${server.url}/api/case-runs/${live.id}`)).json()).caseRun;
      expect(await report()).toMatchObject({ status: "awaiting_confirmation", economyAvailable: false, paidAvailable: false, economyBlocked: "paid_off" });
      // The key alone offers both modes; the run still waits for an explicit confirmation with a budget.
      env = { ANTHROPIC_API_KEY: "test-not-a-key" };
      expect(await report()).toMatchObject({ status: "awaiting_confirmation", economyAvailable: true, paidAvailable: true, economyBlocked: null });
      expect((await post(`/case-runs/${live.id}/confirm`, { execution: "standard" })).status).toBe(400); // no spending limit
      expect(sent).toHaveLength(2); // the mock run and the live estimate: nothing confirmed, so no paid work queued
      const refused = await post(`/case-runs/${live.id}/confirm`, { budgetUsd: 5, execution: "batch" });
      expect(refused.status).toBe(400);
      expect((await refused.json()).code).toBe("retention_not_acknowledged");
      expect((await post(`/case-runs/${live.id}/confirm`, { budgetUsd: 5, execution: "batch", retentionAcknowledged: true, name: "x".repeat(121) })).status).toBe(400);
      const confirmed = await post(`/case-runs/${live.id}/confirm`, { budgetUsd: 5, execution: "batch", retentionAcknowledged: true, name: "  Webb, first pass  " });
      expect(confirmed.status).toBe(202);
      expect((await confirmed.json()).caseRun).toMatchObject({ execution: "batch", status: "queued", name: "Webb, first pass" });

      // Between checks no runner holds the run, but its batches are open at the provider: cancelling marks it, and
      // the next check cancels them and ends the run.
      const p = fake({ processingMs: 60_000 });
      expect(await runCaseRun(db, pool, live.id, batchDeps(p))).toBe("polling");
      sent.length = 0;
      const cancel = await post(`/case-runs/${live.id}/cancel`, {});
      expect(cancel.status).toBe(202);
      expect((await cancel.json()).caseRun).toMatchObject({ status: "adjudicating", cancelRequested: true });
      expect(sent).toEqual([{ caseRunId: live.id }]);
      expect(await drive(live.id, batchDeps(p))).toBe("cancelled");
      expect((await budgetOf(live.id)).reservedUsd).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("stops with blocked_credentials when the server has no batch provider, sending nothing", async () => {
    const run = await liveRun();
    expect(await runCaseRun(db, pool, run.id, { adjudicator: () => standardThrows, minilm: "off", batch: () => null })).toBe("blocked_credentials");
  }, 120_000);
});
