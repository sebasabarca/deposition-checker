// Exact-request reuse (DESIGN.md, "Implementation note: exact-request reuse"), end to end on the isolated test
// database with fake providers only: a scripted stand-in for the Messages API in the live contract (priced as the
// real model, so budgets, recorded calls and stored replies follow the live path) and the fake Message Batches API.
// No API key, no paid call.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKET_MODEL, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import type { Database } from "../../server/src/db/client";
import { adjudicationRequests, candidates, caseRuns, depositions, findings, llmCalls, verdicts } from "../../server/src/db/schema";
import { FakeBatchProvider } from "../../server/src/eval/mockPacketBatch";
import { mockPacketReply } from "../../server/src/eval/mockPacketModel";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunFindings, caseRunReport, caseRunSetOf, confirmCaseRun, createCaseRun, mockCaseModel, resumeCaseRun, runCaseRun, type CasePacketModel, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

type Reply = Awaited<ReturnType<CasePacketModel["adjudicate"]>>;
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) as Reply["usage"];
// The label-blind mock in the live contract (model PACKET_MODEL, so its calls are priced), with a latency, counting
// every call it receives.
function provider({ effort = "medium", model = PACKET_MODEL, latencyMs = 0 }: { effort?: string; model?: string; latencyMs?: number } = {}) {
  const calls: string[] = [];
  const m: CasePacketModel = {
    model, effort, promptVersion: "packet-v1",
    async adjudicate(packet: IssuePacket) {
      calls.push(packet.id);
      if (latencyMs) await new Promise((ok) => setTimeout(ok, latencyMs));
      const r = mockPacketReply(packet);
      return { model: PACKET_MODEL, stopReason: "end_turn", usage: usage(r.usage.inputTokens, 350 * packet.pairs.length), text: r.text, latencyMs, requestId: `req-${calls.length}` };
    },
  };
  return { model: m, calls };
}
const deps = (model: CasePacketModel | null, extra: Partial<CaseRunDeps> = {}): CaseRunDeps => ({ adjudicator: () => model, sleep: async () => undefined, minilm: "off", reuse: true, ...extra });

describe.skipIf(!TEST_DATABASE_URL)("exact-request reuse", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number; // Webb + Whitfield, four sessions
  let otherCase: number; // the same Webb testimony under another case
  let first: number; // the first live run of caseId, every request sent
  const clock = { t: Date.now() };

  const live = (c = caseId, o: { execution?: "standard" | "batch" } = {}) => createCaseRun(db, c, { mode: "live", budgetUsd: 50, confirmed: true, ...o });
  const report = async (id: number) => (await caseRunReport(db, id))!;
  const requests = (id: number) => db.select().from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, caseRunSetOf(id)));
  const signature = async (id: number) => (await caseRunFindings(db, id)).map((f) => `${f.a.exchange}|${f.b.exchange}|${f.type}|${f.score}|${f.priority}|${f.evidenceStatus}|${f.a.lines.map((l) => l.id).join(",")}|${f.b.lines.map((l) => l.id).join(",")}`);
  const duplicates = async (id: number) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from (select v.candidate_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(id)} group by 1 having count(*) > 1) d`)).rows[0].n;
  const verdictsOf = (id: number) => db.select({ v: verdicts }).from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).where(eq(candidates.candidateSet, caseRunSetOf(id)));
  const depositionsOfRequest = async (r: { candidateIds: number[] }) => new Set((await db.select({ a: candidates.depositionA, b: candidates.depositionB }).from(candidates).where(inArray(candidates.id, r.candidateIds))).flatMap((c) => [c.a, c.b]));
  const drive = async (id: number, d: CaseRunDeps) => { for (let i = 0; i < 300; i++) { const out = await runCaseRun(db, pool, id, d); if (out !== "polling") return out; clock.t += 2_000; } throw new Error("still polling"); };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    await storeSessions(db, { ...WEBB_SUITE, caseName: "Reuse scope: the same Webb testimony, another case" });
    const cases = await db.execute<{ case_id: number; n: number }>(sql`select case_id, count(*)::int as n from depositions group by 1 order by 1`);
    caseId = Number(cases.rows.find((c) => c.n === 4)!.case_id);
    otherCase = Number(cases.rows.find((c) => c.n === 2)!.case_id);
    const p = provider();
    first = (await live()).id;
    expect(await runCaseRun(db, pool, first, deps(p.model))).toBe("completed");
    expect(p.calls.length).toBeGreaterThan(5);
  }, 180_000);
  afterAll(async () => { await pool?.end(); });

  it("a repeated run reuses every completed request: nothing sent, nothing charged or reserved, the same findings, verified again", async () => {
    const before = await report(first);
    const p = provider();
    const run = await live();
    expect(await runCaseRun(db, pool, run.id, deps(p.model))).toBe("completed");
    const r = await report(run.id);
    expect(p.calls).toEqual([]);
    expect(r.requests.reused).toBe(before.requests.answered);
    expect(r.requests.answered).toBe(0);
    expect(r.requests.failedNotBilled).toBe(0);
    expect(r.cost).toMatchObject({ recordedCalls: 0, costUsd: 0, budget: { spentUsd: 0, reservedUsd: 0 } });
    expect(r.cost.reuse.avoidedUsdEstimate).toBeCloseTo(before.cost.costUsd, 4);
    expect(r.candidates).toEqual(before.candidates);
    expect(await signature(run.id)).toEqual(await signature(first));
    expect(await duplicates(run.id)).toBe(0);
    // Each verdict was written by this run, from the reused request, and names the call that produced the text.
    const firstCalls = new Set((await requests(first)).map((x) => x.llmCallId));
    const reusedRows = new Map((await requests(run.id)).map((x) => [x.id, x]));
    for (const { v } of await verdictsOf(run.id)) {
      expect(v.origin).toBe("model");
      expect(firstCalls.has(v.llmCallId)).toBe(true);
      expect(reusedRows.get(v.requestId!)?.status).toBe("reused");
    }
    for (const x of reusedRows.values()) expect(x).toMatchObject({ status: "reused", llmCallId: null, reservationId: null, maxCostUsd: 0 });
  }, 120_000);

  it("a fresh analysis reuses nothing and pays for every request; its responses then serve later runs", async () => {
    const p = provider();
    const fresh = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, fresh: true });
    expect(await runCaseRun(db, pool, fresh.id, deps(p.model))).toBe("completed");
    const r = await report(fresh.id);
    expect(r.requests.reused).toBe(0);
    expect(p.calls.length).toBe((await report(first)).requests.answered);
    expect(r.cost.recordedCalls).toBe(p.calls.length);
    expect(r.cost.costUsd).toBeCloseTo((await report(first)).cost.costUsd, 4);
    expect(r.cost.reuse.fresh).toBe(true);
    expect(r.cost.budget!.spentUsd).toBeLessThanOrEqual(50);
    const later = await live();
    expect(await runCaseRun(db, pool, later.id, deps(provider().model))).toBe("completed");
    const sources = new Set((await requests(later.id)).map((x) => x.reusedFromRequestId));
    expect(sources.has(null)).toBe(false); // every request of the later run was reused
    expect((await requests(fresh.id)).some((x) => sources.has(x.id))).toBe(true); // the latest qualifying source: the fresh run's
  }, 120_000);

  it("a source answered by another model id than the one requested is never reused", async () => {
    const latest = (await db.execute<{ id: number }>(sql`select id from case_runs where case_id = ${caseId} and mode = 'live' order by id desc`)).rows.map((x) => Number(x.id));
    const calls = (await db.execute<{ id: number; model: string }>(sql`select l.id, l.model from adjudication_requests r join llm_calls l on l.id = r.llm_call_id join case_runs c on r.candidate_set = 'case-run-' || c.id where c.case_id = ${caseId}`)).rows;
    await db.execute(sql`update llm_calls set model = 'claude-sonnet-5-5-20261201' where id in (${sql.join(calls.map((c) => sql`${c.id}`), sql`, `)})`);
    try {
      const p = provider();
      const run = await live();
      expect(await runCaseRun(db, pool, run.id, deps(p.model))).toBe("completed");
      expect((await report(run.id)).requests.reused).toBe(0);
      expect(p.calls.length).toBe((await report(first)).requests.answered);
    } finally {
      for (const c of calls) await db.execute(sql`update llm_calls set model = ${c.model} where id = ${c.id}`);
      // The run just made is itself a source now; later tests reuse from it or from earlier ones alike.
      expect(latest.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("the estimate expects exactly the reuse the run then gets, and a run confirmed as fresh sends everything", async () => {
    const auto = await createCaseRun(db, caseId, { mode: "live" });
    expect(await runCaseRun(db, pool, auto.id, deps(provider().model))).toBe("awaiting_confirmation");
    const e = (await report(auto.id)).estimate as { packets: number; expectedUsd: number; recommendedBudgetUsd: number; reuse: { checked: boolean; reusableRequests: number; expectedAvoidedUsd: number; economy: { expectedAvoidedUsd: number } } };
    expect(e.reuse.checked).toBe(true);
    expect(e.reuse.reusableRequests).toBe(e.packets);
    expect(e.reuse.expectedAvoidedUsd).toBeCloseTo(e.expectedUsd, 2);
    expect(e.reuse.economy.expectedAvoidedUsd).toBeCloseTo(e.expectedUsd * 0.5, 2);
    expect(await confirmCaseRun(db, auto.id, { budgetUsd: e.recommendedBudgetUsd })).toBe("queued");
    const p = provider();
    expect(await runCaseRun(db, pool, auto.id, deps(p.model))).toBe("completed");
    expect((await report(auto.id)).requests.reused).toBe(e.reuse.reusableRequests);
    expect(p.calls).toEqual([]);
    // The same estimate, confirmed as a fresh analysis: nothing reused, everything sent and charged.
    const fresh = await createCaseRun(db, caseId, { mode: "live" });
    expect(await runCaseRun(db, pool, fresh.id, deps(provider().model))).toBe("awaiting_confirmation");
    expect(await confirmCaseRun(db, fresh.id, { budgetUsd: e.recommendedBudgetUsd, fresh: true })).toBe("queued");
    const q = provider();
    expect(await runCaseRun(db, pool, fresh.id, deps(q.model))).toBe("completed");
    expect((await report(fresh.id)).requests.reused).toBe(0);
    expect(q.calls.length).toBe(e.packets);
    // Without the worker's switch the estimate doesn't look for reuse.
    const off = await createCaseRun(db, caseId, { mode: "live" });
    expect(await runCaseRun(db, pool, off.id, deps(provider().model, { reuse: false }))).toBe("awaiting_confirmation");
    expect(((await report(off.id)).estimate as { reuse: { checked: boolean } }).reuse.checked).toBe(false);
  }, 180_000);

  it("re-reads a reused response with current code: a source whose recorded text no longer verifies gives an unverified finding", async () => {
    // A source whose recorded reply quotes testimony (so its citations can fail to verify once tampered with).
    // The latest run with sent requests holds the sources the next run picks (the latest qualifying one wins).
    const newest = Number((await db.execute<{ id: number }>(sql`select c.id from case_runs c join adjudication_requests r on r.candidate_set = 'case-run-' || c.id where c.case_id = ${caseId} and r.status = 'completed' order by c.id desc limit 1`)).rows[0].id);
    const sources = await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.candidateSet, caseRunSetOf(newest)), eq(adjudicationRequests.status, "completed")));
    let src = sources[0], call = (await db.select().from(llmCalls).where(eq(llmCalls.id, src.llmCallId!)))[0];
    for (const x of sources) {
      const c = (await db.select().from(llmCalls).where(eq(llmCalls.id, x.llmCallId!)))[0];
      if ((JSON.parse(c.rawOutput!) as { verdicts: { keyPhraseA: string | null; outcome: string }[] }).verdicts.some((v) => v.keyPhraseA && ["direct", "inferential", "needs_more_context"].includes(v.outcome))) { src = x; call = c; break; }
    }
    const parsed = JSON.parse(call.rawOutput!) as { verdicts: { keyPhraseA: string | null }[] };
    expect(parsed.verdicts.some((v) => v.keyPhraseA)).toBe(true);
    const tampered = { ...parsed, verdicts: parsed.verdicts.map((v) => ({ ...v, keyPhraseA: v.keyPhraseA ? "words no witness ever said in this deposition" : v.keyPhraseA })) };
    await db.update(llmCalls).set({ rawOutput: JSON.stringify(tampered) }).where(eq(llmCalls.id, call.id));
    try {
      const run = await live();
      expect(await runCaseRun(db, pool, run.id, deps(provider().model))).toBe("completed");
      const hit = (await requests(run.id)).find((x) => x.reusedFromRequestId === src.id)!;
      expect(hit).toBeDefined();
      const statuses = (await db.select({ status: findings.evidenceStatus }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(inArray(candidates.id, hit.candidateIds))).map((f) => f.status);
      const original = (await db.select({ status: findings.evidenceStatus }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(inArray(candidates.id, src.candidateIds))).map((f) => f.status);
      expect(original.some((s) => s === "verified")).toBe(true); // the untampered reply verified
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every((s) => s !== "verified")).toBe(true); // the same reply, tampered, no longer does: it was checked again
    } finally {
      await db.update(llmCalls).set({ rawOutput: call.rawOutput }).where(eq(llmCalls.id, call.id));
    }
  }, 120_000);

  it("changed evidence misses: a re-parsed deposition's requests are sent, every other request is reused", async () => {
    const [dep] = await db.select().from(depositions).where(eq(depositions.caseId, caseId)).orderBy(depositions.id).limit(1);
    await db.update(depositions).set({ parserVersion: `${dep.parserVersion}-reparsed` }).where(eq(depositions.id, dep.id));
    try {
      const p = provider();
      const run = await live();
      expect(await runCaseRun(db, pool, run.id, deps(p.model))).toBe("completed");
      const rows = await requests(run.id);
      expect(p.calls.length).toBeGreaterThan(0);
      expect(rows.some((x) => x.status === "reused")).toBe(true);
      for (const x of rows) {
        const deps_ = await depositionsOfRequest(x);
        if (x.status === "reused") expect(deps_.has(dep.id)).toBe(false);
        else expect(deps_.has(dep.id)).toBe(true);
      }
    } finally {
      await db.update(depositions).set({ parserVersion: dep.parserVersion }).where(eq(depositions.id, dep.id));
    }
  }, 120_000);

  it("a different model, effort or contract misses entirely", async () => {
    for (const p of [provider({ effort: "low" }), provider({ model: "claude-haiku-5-5" })]) {
      const run = await live();
      expect(await runCaseRun(db, pool, run.id, deps(p.model))).toBe("completed");
      expect((await report(run.id)).requests.reused).toBe(0);
      expect(p.calls.length).toBe((await report(first)).requests.answered);
    }
    const stretch = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, contract: "stretch-v2" });
    const s = mockCaseModel(PACKET_MODEL, "stretch-v2");
    expect(await runCaseRun(db, pool, stretch.id, deps({ ...s, effort: "medium" }))).toBe("completed");
    expect((await report(stretch.id)).requests.reused).toBe(0);
  }, 180_000);

  it("is case-scoped, off for mock runs, and off when the server switch is off", async () => {
    const p = provider();
    const other = await live(otherCase);
    expect(await runCaseRun(db, pool, other.id, deps(p.model))).toBe("completed");
    expect((await report(other.id)).requests.reused).toBe(0); // the same testimony in another case is never a source
    expect(p.calls.length).toBeGreaterThan(0);
    const mock = await createCaseRun(db, caseId, { mode: "mock" });
    expect(await runCaseRun(db, pool, mock.id, deps(null))).toBe("completed");
    expect((await requests(mock.id)).some((x) => x.status === "reused")).toBe(false);
    const off = provider();
    const run = await live();
    expect(await runCaseRun(db, pool, run.id, deps(off.model, { reuse: false }))).toBe("completed");
    expect(off.calls.length).toBe((await report(first)).requests.answered);
  }, 180_000);

  it("a crash after a reuse is recorded is recovered from the stored pointer: no duplicate verdict, nothing charged", async () => {
    const run = await live();
    let crashed = false;
    const crash = deps(provider().model, { faults: { afterReuseRecorded: () => { if (!crashed) { crashed = true; throw new Error("worker died"); } } } });
    await expect(runCaseRun(db, pool, run.id, crash)).rejects.toThrow("worker died");
    expect(await runCaseRun(db, pool, run.id, deps(provider().model))).toBe("interrupted");
    expect(await resumeCaseRun(db, run.id, {})).toBe("queued");
    const p = provider();
    expect(await runCaseRun(db, pool, run.id, deps(p.model))).toBe("completed");
    expect(p.calls).toEqual([]);
    expect(await duplicates(run.id)).toBe(0);
    expect(await signature(run.id)).toEqual(await signature(first));
    expect((await report(run.id)).cost).toMatchObject({ recordedCalls: 0, costUsd: 0, budget: { spentUsd: 0, reservedUsd: 0 } });
  }, 120_000);

  it("concurrent runs of the same case with several lanes each: both complete, no duplicates, no charges", async () => {
    const [a, b] = [await live(), await live()];
    const [pa, pb] = [provider(), provider()];
    const out = await Promise.all([runCaseRun(db, pool, a.id, deps(pa.model, { concurrency: 3 })), runCaseRun(db, pool, b.id, deps(pb.model, { concurrency: 3 }))]);
    expect(out).toEqual(["completed", "completed"]);
    expect([...pa.calls, ...pb.calls]).toEqual([]);
    for (const id of [a.id, b.id]) {
      expect(await duplicates(id)).toBe(0);
      expect(await signature(id)).toEqual(await signature(first));
      expect((await report(id)).cost.costUsd).toBe(0);
    }
  }, 120_000);

  it("economy: a repeated run submits no batch, and a request still in an open batch is never a source", async () => {
    const fake = new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 5_000, now: () => clock.t });
    const standardThrows: CasePacketModel = { model: PACKET_MODEL, effort: "medium", promptVersion: "packet-v1", adjudicate: async () => { throw new Error("used the standard transport"); } };
    const batchDeps = (p: FakeBatchProvider): CaseRunDeps => deps(standardThrows, { batch: () => ({ provider: p, settings: { batchSize: 4, inFlight: 3 }, now: () => clock.t }) });
    // Reuse from a standard run: the economy run sends nothing; the avoided cost is priced at batch rates.
    const econ = await live(caseId, { execution: "batch" });
    expect(await drive(econ.id, batchDeps(fake))).toBe("completed");
    expect(fake.sentPerPacket.size).toBe(0);
    const r = await report(econ.id);
    expect(r.cost.costUsd).toBe(0);
    expect(r.cost.reuse.avoidedUsdEstimate).toBeCloseTo((await report(first)).cost.costUsd * 0.5, 4);
    expect(await signature(econ.id)).toEqual(await signature(first));
    // A pending batch: the other case's economy run submits and is left open; a standard run of that case meanwhile
    // finds no completed source in it.
    const pending = new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 3_600_000, now: () => clock.t });
    const open = await live(otherCase, { execution: "batch" });
    const otherFirst = (await db.select({ id: caseRuns.id }).from(caseRuns).where(and(eq(caseRuns.caseId, otherCase), eq(caseRuns.execution, "standard"))))[0].id;
    await db.update(adjudicationRequests).set({ status: "aborted", errorKind: "aborted" }).where(eq(adjudicationRequests.candidateSet, caseRunSetOf(otherFirst))); // leave only the open batch as a possible source
    expect(await runCaseRun(db, pool, open.id, batchDeps(pending))).toBe("polling");
    expect(pending.sentPerPacket.size).toBeGreaterThan(0);
    const p = provider();
    const meanwhile = await live(otherCase);
    expect(await runCaseRun(db, pool, meanwhile.id, deps(p.model))).toBe("completed");
    expect((await report(meanwhile.id)).requests.reused).toBe(0);
    expect(p.calls.length).toBeGreaterThan(0);
  }, 180_000);

  it("a human review of an earlier finding is untouched, and citations are the same stored lines", async () => {
    const [f] = await caseRunFindings(db, first);
    await db.update(findings).set({ reviewState: "confirmed", reviewNote: "checked against the transcript", reviewedAt: new Date() }).where(eq(findings.id, f.id));
    const run = await live();
    expect(await runCaseRun(db, pool, run.id, deps(provider().model))).toBe("completed");
    const [after] = await db.select().from(findings).where(eq(findings.id, f.id));
    expect(after).toMatchObject({ reviewState: "confirmed", reviewNote: "checked against the transcript" });
    const mine = await caseRunFindings(db, run.id);
    expect(mine.every((x) => x.reviewState === "unreviewed")).toBe(true);
    expect(mine.map((x) => [x.a.lines, x.b.lines])).toEqual((await caseRunFindings(db, first)).map((x) => [x.a.lines, x.b.lines]));
  }, 120_000);
});

// A case that grows by one deposition: every request it hasn't seen is sent; only identical requests are reused.
describe.skipIf(!TEST_DATABASE_URL)("exact-request reuse when a deposition is added", () => {
  let db: Database;
  let pool: Pool;
  beforeAll(async () => { ({ db, pool } = await openTestDatabase()); await emptyTables(db); }, 60_000);
  afterAll(async () => { await pool?.end(); });

  it("sends every request that touches the new deposition or changed, reuses only identical ones", async () => {
    const name = "Reuse growth case";
    await storeSessions(db, { ...WEBB_SUITE, caseName: name });
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: name, sessions: WHITFIELD_SUITE.sessions.slice(0, 1) });
    const [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
    const p1 = provider();
    const r1 = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, r1.id, deps(p1.model))).toBe("completed");
    const seen = new Set((await db.select({ f: adjudicationRequests.requestFingerprint }).from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, caseRunSetOf(r1.id)))).map((x) => x.f));
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: name, sessions: WHITFIELD_SUITE.sessions.slice(1) });
    const added = (await db.select({ id: depositions.id }).from(depositions).where(eq(depositions.caseId, caseId)).orderBy(depositions.id)).at(-1)!.id;
    const p2 = provider();
    const r2 = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, r2.id, deps(p2.model))).toBe("completed");
    const rows = await db.select().from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, caseRunSetOf(r2.id)));
    let touching = 0;
    for (const x of rows) {
      const ds = new Set((await db.select({ a: candidates.depositionA, b: candidates.depositionB }).from(candidates).where(inArray(candidates.id, x.candidateIds))).flatMap((c) => [c.a, c.b]));
      if (ds.has(added)) { touching++; expect(x.status).not.toBe("reused"); }
      if (x.status === "reused") expect(seen.has(x.requestFingerprint)).toBe(true);
      else expect(x.status).toBe("completed");
    }
    expect(touching).toBeGreaterThan(0);
    expect(p2.calls.length).toBe(rows.filter((x) => x.status !== "reused").length);
  }, 180_000);
});
