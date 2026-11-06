// End to end: a whole-case run over a stored two-witness, four-session synthetic case (Webb and Whitfield
// under one case), on the isolated test database, with the deterministic label-blind mock model. No API key,
// no paid call. "Live" runs here use the mock in place of the Anthropic client, so budgets, recorded calls,
// stored replies and restarts follow the live path. See tests/db/database.ts for when these run.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, sql } from "drizzle-orm";
import express from "express";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseRunRoutes, reportRoutes } from "../../server/src/api";
import { caseRunReportData } from "../../server/src/api/report";
import { PACKET_MODEL, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import type { Database } from "../../server/src/db/client";
import { adjudicationRequests, candidates, caseRuns, depositions, findings, llmCalls, screeningEntries, screeningRuns, verdicts } from "../../server/src/db/schema";
import { mockPacketReply } from "../../server/src/eval/mockPacketModel";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { CASE_RUN_RUNNER_STALE_MS, caseRunFindings, caseRunReport, caseRunSetOf, confirmCaseRun, createCaseRun, orphanedCaseRuns, mockCaseModel, resumeCaseRun, runCaseRun, type CasePacketModel, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

type Reply = Awaited<ReturnType<CasePacketModel["adjudicate"]>>;
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) as Reply["usage"];
// The mock in the live contract (model PACKET_MODEL, so calls are priced), with per-call control.
// outputPerPair: reported output tokens per pair, to make spend realistic (the mock itself reports 350).
function scripted(step: (packet: IssuePacket, call: number) => { drop?: string[]; garble?: boolean } | Error = () => ({}), outputPerPair?: number) {
  const calls: string[] = [];
  const perPacket = new Map<string, number>();
  const model: CasePacketModel = {
    model: PACKET_MODEL, effort: "medium", promptVersion: "packet-v1",
    async adjudicate(packet) {
      const n = (perPacket.get(packet.id) ?? 0) + 1;
      perPacket.set(packet.id, n);
      calls.push(packet.id);
      const s = step(packet, n);
      if (s instanceof Error) throw s;
      const m = mockPacketReply(packet, s);
      return { model: PACKET_MODEL, stopReason: "end_turn", usage: usage(m.usage.inputTokens, outputPerPair ? outputPerPair * packet.pairs.length : m.usage.outputTokens), text: m.text, latencyMs: 1, requestId: `req-${calls.length}` };
    },
  };
  return { model, calls };
}
const deps = (model: CasePacketModel | null, extra: Partial<CaseRunDeps> = {}): CaseRunDeps => ({ adjudicator: () => model, sleep: async () => undefined, minilm: "off", ...extra });

describe.skipIf(!TEST_DATABASE_URL)("whole-case run", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let mockRun: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
    mockRun = (await createCaseRun(db, caseId, { mode: "mock", budgetUsd: 0 })).id;
    expect(await runCaseRun(db, pool, mockRun, deps(null))).toBe("completed");
  }, 180_000);
  afterAll(async () => { await pool?.end(); });

  const findingCount = async (runId: number) => (await db.select({ n: sql<number>`count(*)::int` }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, caseRunSetOf(runId))))[0].n;
  const duplicates = async (runId: number) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from (select v.candidate_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(runId)} group by 1 having count(*) > 1) d`)).rows[0].n;

  it("accounts for every retrieved pair, same-witness and cross-witness, with a reason for each one not read", async () => {
    const r = (await caseRunReport(db, mockRun))!;
    const c = r.candidates;
    expect(c.total).toBeGreaterThan(50);
    expect(c.adjudicated + c.pending + c.incomplete + c.deferred + c.uncovered + c.excluded).toBe(c.total);
    expect(c.sameWitness).toBeGreaterThan(0);
    expect(c.crossWitness).toBeGreaterThan(0);
    const unread = await db.select().from(candidates).where(and(eq(candidates.candidateSet, caseRunSetOf(mockRun)), sql`${candidates.status} in ('deferred', 'uncovered')`));
    expect(unread.every((u) => (u.deferredReason ?? "").length > 0)).toBe(true);
    // Every packet adjudicated, but triage deferred at least one pair: done, and honestly not complete.
    expect(r.status).toBe("completed");
    expect(r.packets.adjudicated).toBe(r.packets.total);
    expect(c.deferred).toBeGreaterThan(0);
    // The deferral is retrieval triage's coverage stage (each item keeps its 2 best partner passages), not screening.
    expect(Object.keys(c.deferredByStage)).toEqual(["triage coverage"]);
    expect(r.coverageState).toBe("processed_with_unread");
    expect(r.complete).toBe(false);
    expect(r.incompleteReasons.join(" ")).toContain("deferred by retrieval triage, unread");
    // Mock mode is never billed and never recorded as a model call.
    expect(r.cost.recordedCalls).toBe(0);
    expect(await db.$count(llmCalls)).toBe(0);
  });

  it("links every ledger entry to database IDs and the source hash", async () => {
    const [ledger] = await db.select().from(screeningRuns).where(eq(screeningRuns.caseRunId, mockRun));
    expect(ledger).toMatchObject({ caseId, strategy: "baseline" });
    expect(ledger.sourceHash).toBe((await db.select().from(caseRuns).where(eq(caseRuns.id, mockRun)))[0].sourceHash);
    const entries = await db.select().from(screeningEntries).where(eq(screeningEntries.runId, ledger.id));
    expect(entries.every((e) => e.screenStatus === "prioritized")).toBe(true); // screening off: nothing deferred by budget
    expect(entries.every((e) => e.pairs.length <= 8)).toBe(true);
    expect(entries.reduce((n, e) => n + e.pairs.length, 0) + ledger.uncovered.length).toBe(ledger.poolPairs);
    for (const e of entries) {
      expect(e.candidateIds).toHaveLength(e.pairs.length);
      expect(e.exchangeIds!.length).toBeGreaterThan(0);
      expect(e.documentIds!.length).toBeGreaterThanOrEqual(2);
      expect(e.sessionIds!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("shows every finding's two sides as stored lines at page:line, apart from the model's verdict", async () => {
    const list = await caseRunFindings(db, mockRun);
    expect(list.length).toBe(await findingCount(mockRun));
    expect(list.some((f) => f.crossWitness)).toBe(true);
    expect(list.some((f) => !f.crossWitness)).toBe(true);
    for (const f of list.slice(0, 20)) {
      for (const side of [f.a, f.b]) {
        expect(side.lines.length).toBeGreaterThan(0);
        expect(side.range).toMatch(/^\d+:\d{2}–\d+:\d{2}$/);
        const stored = await db.execute<{ deposition_id: number; raw_text: string }>(sql`select deposition_id, raw_text from lines where id = ${side.lines[0].id}`);
        expect(Number(stored.rows[0].deposition_id)).toBe(side.depositionId);
        expect(stored.rows[0].raw_text).toBe(side.lines[0].text);
      }
      expect(f.model.origin).toBe("fixture");
    }
    expect(await duplicates(mockRun)).toBe(0);
  });

  it("finds runs that say they are working but that no worker holds, and leaves the others", async () => {
    const make = async (status: string, execution: string, seenAgoMs: number | null, updatedAgoMs: number) => {
      const id = (await createCaseRun(db, caseId, { mode: "mock", budgetUsd: 0 })).id;
      const ago = (ms: number) => new Date(Date.now() - ms);
      await db.update(caseRuns).set({ status: status as never, execution: execution as never, runnerSeenAt: seenAgoMs === null ? null : ago(seenAgoMs), updatedAt: ago(updatedAgoMs) }).where(eq(caseRuns.id, id));
      return id;
    };
    const old = CASE_RUN_RUNNER_STALE_MS * 10;
    const lost = await make("adjudicating", "standard", old, old); // its runner stopped long ago
    const neverClaimed = await make("queued", "standard", null, old);
    const working = await make("adjudicating", "standard", 1000, old); // a runner's heartbeat is fresh
    const justQueued = await make("queued", "standard", null, 1000);
    const economy = await make("adjudicating", "batch", old, old); // kept going by its own batch checks
    const waiting = await make("awaiting_confirmation", "standard", null, old);
    const found = await orphanedCaseRuns(db);
    expect(found).toEqual(expect.arrayContaining([lost, neverClaimed]));
    for (const id of [working, justQueued, economy, waiting]) expect(found).not.toContain(id);
    await db.delete(caseRuns).where(sql`${caseRuns.id} in (${sql.join([lost, neverClaimed, working, justQueued, economy, waiting].map((x) => sql`${x}`), sql`, `)})`);
  });

  it("reports the findings kept from a run, with Needs context only when asked, as a PDF", async () => {
    const ids = (await db.select({ id: findings.id }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, caseRunSetOf(mockRun))).orderBy(findings.id)).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await db.update(findings).set({ reviewState: "confirmed", reviewNote: "Ask about the date." }).where(eq(findings.id, ids[0]));
    await db.update(findings).set({ reviewState: "needs_context" }).where(eq(findings.id, ids[1]));
    try {
      const kept = await caseRunReportData(db, mockRun, false);
      expect(kept).toMatchObject({ kept: 1, context: 1, withContext: false });
      expect(kept!.entries.map((e) => [e.id, e.reviewNote])).toEqual([[ids[0], "Ask about the date."]]);
      expect(kept!.entries[0].a.lines.length).toBeGreaterThan(0); // the stored testimony, at page:line
      expect((await caseRunReportData(db, mockRun, true))!.entries.map((e) => e.id)).toEqual([ids[0], ids[1]]);
      const app = express();
      app.use("/api", reportRoutes({ db }));
      const server = await listen(app);
      try {
        const res = await fetch(`${server.url}/api/case-runs/${mockRun}/report.pdf`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/pdf");
        expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
        expect((await fetch(`${server.url}/api/case-runs/999999/report.pdf`)).status).toBe(404);
      } finally { await server.close(); }
    } finally {
      await db.update(findings).set({ reviewState: "unreviewed", reviewNote: null }).where(inArray(findings.id, ids.slice(0, 2)));
    }
  });

  it("does nothing more when run again", async () => {
    const before = await findingCount(mockRun);
    expect(await runCaseRun(db, pool, mockRun, deps(null))).toBe("completed");
    expect(await findingCount(mockRun)).toBe(before);
  });

  it("stops at the budget, keeps its findings, and finishes on resume without re-sending a packet", async () => {
    const { model, calls } = scripted(() => ({}), 4000);
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 1.5, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("blocked_budget");
    const stopped = (await caseRunReport(db, run.id))!;
    expect(stopped.packets.adjudicated).toBeGreaterThan(0);
    expect(stopped.packets.notStarted).toBeGreaterThan(0);
    expect(stopped.cost.budget!.spentUsd + stopped.cost.budget!.reservedUsd).toBeLessThanOrEqual(1.5);
    expect(stopped.cost.costUsd).toBeGreaterThan(0);
    const kept = await findingCount(run.id);
    expect(kept).toBeGreaterThan(0);

    expect(await resumeCaseRun(db, run.id, { budgetUsd: 1 })).toBe("lower_budget");
    expect(await resumeCaseRun(db, run.id, { budgetUsd: 50 })).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("completed");
    const done = (await caseRunReport(db, run.id))!;
    expect(done.packets.adjudicated).toBe(done.packets.total);
    expect(new Set(calls).size).toBe(calls.length); // no packet was sent twice
    expect(done.cost.recordedCalls).toBe(calls.length);
    expect(await findingCount(run.id)).toBe(await findingCount(mockRun)); // the same mock verdicts as the mock run
    expect(await duplicates(run.id)).toBe(0);
  }, 120_000);

  it("recovers from a crash after a paid reply without paying for it again", async () => {
    const { model, calls } = scripted();
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    const snapshot = async () => ({
      sourceHash: (await db.select().from(caseRuns).where(eq(caseRuns.id, run.id)))[0].sourceHash,
      entries: (await db.select({ packetId: screeningEntries.packetId, candidateIds: screeningEntries.candidateIds, exchangeIds: screeningEntries.exchangeIds, documentIds: screeningEntries.documentIds, sessionIds: screeningEntries.sessionIds }).from(screeningEntries).innerJoin(screeningRuns, eq(screeningRuns.id, screeningEntries.runId)).where(eq(screeningRuns.caseRunId, run.id)).orderBy(screeningEntries.packetId)),
    });
    let crashed: string | null = null;
    const crashing = deps(model, { faults: { afterReplyRecorded: (id) => { if (calls.length === 3 && !crashed) { crashed = id; throw new Error("worker killed"); } } } });
    await expect(runCaseRun(db, pool, run.id, crashing)).rejects.toThrow("worker killed");
    const [mid] = await db.select().from(caseRuns).where(eq(caseRuns.id, run.id));
    expect(mid.status).toBe("adjudicating");
    const before = await snapshot();
    const [held] = await db.select().from(screeningEntries).where(eq(screeningEntries.packetId, crashed!)).orderBy(sql`${screeningEntries.id} desc`).limit(1);
    expect(held.llmCallId).not.toBeNull(); // the paid reply is stored, not yet turned into verdicts

    // A new delivery of a live run that was mid-stage never resumes spending on its own.
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("interrupted");
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("completed");
    expect(calls.filter((c) => c === crashed)).toHaveLength(1); // the stored reply was parsed, not bought again
    expect(await snapshot()).toEqual(before); // source hash, packet, candidate, exchange, document and session IDs unchanged
    expect(new Set(calls).size).toBe(calls.length);
    expect(await duplicates(run.id)).toBe(0);
    expect(await findingCount(run.id)).toBe(await findingCount(mockRun));
  }, 120_000);

  it("recovers unanswered pairs once, then leaves the rest incomplete and listed, never as compatible", async () => {
    // First packet: R1 dropped on the first reply, answered by the recovery request.
    // Second packet: R1 dropped every time. Third packet: unreadable every time.
    const order: string[] = [];
    const { model, calls } = scripted((packet, n) => {
      if (!order.includes(packet.id)) order.push(packet.id);
      const which = order.indexOf(packet.id);
      if (which === 0 && n === 1) return { drop: ["R1"] };
      if (which === 1) return { drop: ["R1"] };
      if (which === 2) return { garble: true };
      return {};
    });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("incomplete");
    expect(calls.filter((c) => c === order[0])).toHaveLength(2);
    expect(calls.filter((c) => c === order[1])).toHaveLength(2); // one packet request, one recovery: bounded
    const r = (await caseRunReport(db, run.id))!;
    expect(r.packets.incomplete).toBe(2);
    expect(r.unresolved.map((u) => u.packetId).sort()).toEqual([order[1], order[2]].sort());
    expect(r.unresolved.every((u) => (u.pairs ?? []).length > 0)).toBe(true);
    expect(r.candidates.incomplete).toBeGreaterThan(0); // unanswered pairs stay unread, counted apart from pending
    expect(r.candidates.pending).toBe(0);
    expect(r.coverageState).toBe("partial");
    expect(r.complete).toBe(false);
    // A resume tries those packets again; this time the model answers.
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(scripted().model))).toBe("completed");
    expect(await findingCount(run.id)).toBe(await findingCount(mockRun));
    expect(await duplicates(run.id)).toBe(0);
  }, 120_000);

  it("records failures with whether they may have been billed, retries rate limits, and keeps going", async () => {
    let first: string | null = null;
    const { model } = scripted((packet, n) => {
      first ??= packet.id;
      if (packet.id === first) return new Anthropic.InternalServerError(500, { type: "error" }, "server error", new Headers());
      if (n === 1) return new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers({ "retry-after": "1" }));
      return {};
    });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("incomplete");
    const r = (await caseRunReport(db, run.id))!;
    expect(r.packets.failed).toBe(1);
    expect(r.packets.uncertain).toBe(1); // a 500 may have been billed: counted in full, not retried automatically
    expect(r.unresolved[0]).toMatchObject({ packetId: first, status: "failed", uncertain: true });
    expect(r.requests.uncertain).toBe(1);
    expect(r.coverageState).toBe("partial");
    expect(r.candidates.incomplete).toBeGreaterThan(0);
    const limited = await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.candidateSet, caseRunSetOf(run.id)), eq(adjudicationRequests.status, "rate_limited")));
    expect(limited.length).toBe(r.packets.total - 1);
    expect(r.packets.adjudicated).toBe(r.packets.total - 1);
  }, 120_000);


  it("waits for confirmation before a live run spends anything, with an estimate to confirm", async () => {
    const { model, calls } = scripted();
    const run = await createCaseRun(db, caseId, { mode: "live" });
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("awaiting_confirmation");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("awaiting_confirmation"); // a redelivery does nothing
    const r = (await caseRunReport(db, run.id))!;
    expect(calls).toHaveLength(0);
    expect(r.requests.total).toBe(0);
    expect(r.estimate).toMatchObject({ packets: r.packets.total });
    const e = r.estimate as { expectedUsd: number; recommendedBudgetUsd: number; listedPairs: number };
    expect(e.recommendedBudgetUsd).toBeGreaterThan(e.expectedUsd);
    expect(e.listedPairs).toBe(r.candidates.pending);
    expect(await confirmCaseRun(db, run.id, { budgetUsd: 0 })).toBe("no_budget");
    expect(await confirmCaseRun(db, run.id, { budgetUsd: e.recommendedBudgetUsd * 2 })).toBe("queued");
    expect(await confirmCaseRun(db, run.id, { budgetUsd: 50 })).toBe("not_awaiting");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("completed");
    expect(await findingCount(run.id)).toBe(await findingCount(mockRun));
  }, 120_000);

  it("splits packets past the limits, keeps every original pair once, and resumes across split parts", async () => {
    const { model, calls } = scripted();
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    const limits = { maxPairs: 2, maxInputTokens: 9_000 };
    let crashed = false;
    const crash = deps(model, { packetLimits: limits, faults: { afterReplyRecorded: () => { if (calls.length === 5 && !crashed) { crashed = true; throw new Error("worker killed"); } } } });
    await expect(runCaseRun(db, pool, run.id, crash)).rejects.toThrow("worker killed");
    const [ledger] = await db.select().from(screeningRuns).where(eq(screeningRuns.caseRunId, run.id));
    const entries = await db.select().from(screeningEntries).where(eq(screeningEntries.runId, ledger.id));
    const splitFrom = (ledger.settings as { splitFrom: Record<string, string> }).splitFrom;
    expect(Object.keys(splitFrom).length).toBeGreaterThan(0);
    expect(entries.every((e) => e.pairs.length <= 2)).toBe(true);
    const pairs = entries.flatMap((e) => e.pairs.map(([a, b]) => `${a}|${b}`));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs.length + ledger.uncovered.length).toBe(ledger.poolPairs);
    expect(new Set(entries.flatMap((e) => e.candidateIds!)).size).toBe(pairs.length);
    expect(await runCaseRun(db, pool, run.id, deps(model, { packetLimits: limits }))).toBe("interrupted");
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(model, { packetLimits: limits }))).toBe("completed");
    expect(new Set(calls).size).toBe(calls.length);
    expect(await findingCount(run.id)).toBe(await findingCount(mockRun));
    expect(await duplicates(run.id)).toBe(0);
  }, 120_000);

  it("never retries automatically a request the provider may have received before a crash", async () => {
    const { model, calls } = scripted();
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    let lost: string | null = null;
    const crash = deps(model, { faults: { afterRequestSent: (id) => { if (calls.length === 2 && !lost) { lost = id; throw new Error("worker killed in flight"); } } } });
    await expect(runCaseRun(db, pool, run.id, crash)).rejects.toThrow("worker killed in flight");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("interrupted");
    const r = (await caseRunReport(db, run.id))!;
    expect(r.requests).toMatchObject({ uncertain: 1, open: 0 });
    expect(r.packets).toMatchObject({ failed: 1, uncertain: 1 });
    expect(r.unresolved[0]).toMatchObject({ packetId: lost, status: "failed", uncertain: true });
    expect(r.cost.budget!.reservedUsd).toBe(0); // the open reservation was counted in full, not left held

    // A plain resume finishes everything else and leaves the uncertain packet alone.
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("incomplete");
    expect(calls.filter((c) => c === lost)).toHaveLength(0);
    expect((await caseRunReport(db, run.id))!.packets).toMatchObject({ failed: 1, uncertain: 1, notStarted: 0 });
    // Only an explicit request retries it.
    expect(await resumeCaseRun(db, run.id, { retryUncertain: true })).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(model))).toBe("completed");
    expect(calls.filter((c) => c === lost)).toHaveLength(1);
    expect(await findingCount(run.id)).toBe(await findingCount(mockRun));
  }, 120_000);

  it("serves a run's coverage and findings over the API", async () => {
    const boss = { send: async () => null } as unknown as PgBoss;
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.user = { analysisAccess: false }; next(); }); // an account without paid access
    app.use("/api", caseRunRoutes({ db, boss, env: { ...process.env, ALLOW_TEST_RUNS: "true" } }));
    const server = await listen(app);
    try {
      const report = await (await fetch(`${server.url}/api/case-runs/${mockRun}`)).json();
      expect(report.caseRun).toMatchObject({ id: mockRun, status: "completed", complete: false });
      const listed = await (await fetch(`${server.url}/api/case-runs/${mockRun}/findings`)).json();
      expect(listed.findings.length).toBe(await findingCount(mockRun));
      expect(listed.incompleteReasons.length).toBeGreaterThan(0);
      const post = (path: string, body: unknown) => fetch(`${server.url}/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post(`/cases/${caseId}/case-runs`, { mode: "live", budgetUsd: 5 })).status).toBe(400); // the budget comes with confirmation
      // Resuming: allowed for a mock run, refused for a live run without paid access.
      expect((await post(`/case-runs/${mockRun}/resume`, {})).status).toBe(409); // completed: nothing to resume, but not refused for access
      const [liveRun] = await db.select({ id: caseRuns.id }).from(caseRuns).where(eq(caseRuns.mode, "live")).limit(1);
      expect((await post(`/case-runs/${liveRun.id}/resume`, {})).status).toBe(403);
      // A whole case needs more than a two-session check's $20 ceiling: $60 passes validation (409 here only
      // because this run isn't awaiting confirmation); past the case-run ceiling is refused, naming it.
      expect((await post(`/case-runs/${mockRun}/confirm`, { budgetUsd: 60 })).status).toBe(409);
      const over = await post(`/case-runs/${mockRun}/confirm`, { budgetUsd: 300 });
      expect(over.status).toBe(400);
      expect((await over.json()).error).toContain("250");
      const started = await post(`/cases/${caseId}/case-runs`, { mode: "mock" });
      expect(started.status).toBe(202);
      expect(await db.$count(verdicts)).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
