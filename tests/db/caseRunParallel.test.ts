// Whole-case runs with several packets in flight: the same findings and accounting as one at a time, a fair share
// between runs, the budget never overspent, and safe stops (cancel, drain, shutdown, crash, database failure).
// The deterministic label-blind mock stands in for the provider, with real latency so lanes overlap. No API key.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maxOutputTokensFor, PACKET_MODEL, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import type { Database } from "../../server/src/db/client";
import { adjudicationRequests, budgets, candidates, caseRuns, depositions, findings, verdicts } from "../../server/src/db/schema";
import { mockPacketReply } from "../../server/src/eval/mockPacketModel";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunFindings, caseRunReport, caseRunSetOf, confirmCaseRun, createCaseRun, resumeCaseRun, runCaseRun, type CasePacketModel, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { ProviderLimiter, UNLIMITED } from "../../server/src/jobs/limiter";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

type Reply = Awaited<ReturnType<CasePacketModel["adjudicate"]>>;
type Step = { drop?: string[]; hang?: boolean } | Error;

// The mock in the live contract, with latency, per-run in-flight tracking and per-call control.
function provider(step: (packet: IssuePacket, call: number) => Step = () => ({}), { latencyMs = 5, outputPerPair = 0 } = {}) {
  const calls: string[] = [];
  const perPacket = new Map<string, number>();
  const state = { inFlight: 0, peak: 0 };
  const model: CasePacketModel = {
    model: PACKET_MODEL, effort: "medium", promptVersion: "packet-v1",
    async adjudicate(packet, options) {
      const n = (perPacket.get(packet.id) ?? 0) + 1;
      perPacket.set(packet.id, n);
      calls.push(packet.id);
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        const s = step(packet, n);
        await new Promise<void>((ok, no) => {
          const abort = () => no(new Anthropic.APIUserAbortError());
          if (options?.signal?.aborted) return abort();
          options?.signal?.addEventListener("abort", abort, { once: true });
          if (!(s instanceof Error) && s.hang) return; // never answers: only the abort ends it
          setTimeout(ok, latencyMs);
        });
        if (s instanceof Error) throw s;
        const m = mockPacketReply(packet, s);
        const usage = { input_tokens: m.usage.inputTokens, output_tokens: outputPerPair ? outputPerPair * packet.pairs.length : m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Reply["usage"];
        return { model: PACKET_MODEL, stopReason: "end_turn", usage, text: m.text, latencyMs, requestId: `req-${calls.length}` };
      } finally {
        state.inFlight--;
      }
    },
  };
  return { model, calls, state };
}
const deps = (model: CasePacketModel | null, extra: Partial<CaseRunDeps> = {}): CaseRunDeps => ({ adjudicator: () => model, sleep: async () => undefined, minilm: "off", ...extra });
const until = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((ok) => setTimeout(ok, 10));
  }
};

describe.skipIf(!TEST_DATABASE_URL)("whole-case run, in parallel", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let sequential: number;

  // Every verdict and finding keyed by the candidate's two passages, so different runs compare.
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
  const openRequests = async (runId: number) => db.$count(adjudicationRequests, and(eq(adjudicationRequests.candidateSet, caseRunSetOf(runId)), eq(adjudicationRequests.status, "sent")));

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
    sequential = (await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true })).id;
    expect(await runCaseRun(db, pool, sequential, deps(provider().model))).toBe("completed");
  }, 180_000);
  afterAll(async () => { await pool?.end(); });

  it("gives the same verdicts, findings, scores and candidate accounting as one packet at a time", async () => {
    const p = provider(() => ({}), { latencyMs: 20 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("completed");
    expect(p.state.peak).toBeGreaterThan(1); // packets overlapped (how many depends on timing)
    expect(p.state.peak).toBeLessThanOrEqual(4);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
    expect(await accounting(run.id)).toEqual(await accounting(sequential));
    expect(await duplicates(run.id)).toBe(0);
    expect(new Set(p.calls).size).toBe(p.calls.length); // every packet sent once
    const b = await budgetOf(run.id);
    expect(b.reservedUsd).toBe(0);
    expect((await caseRunReport(db, run.id))!.cost.costUsd).toBeCloseTo(b.spentUsd, 6);
    // Findings are listed in retrieval order, whatever order the packets finished in.
    const order = (f: Awaited<ReturnType<typeof caseRunFindings>>) => f.map((x) => `${x.a.exchange}|${x.b.exchange}|${x.type}`);
    expect(order(await caseRunFindings(db, run.id))).toEqual(order(await caseRunFindings(db, sequential)));
  }, 120_000);

  it("shares the global limit fairly between runs at once, and releases every slot", async () => {
    const limiter = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 3 });
    const order: string[] = [];
    const grants: string[] = [];
    const acquire = limiter.acquireSlot.bind(limiter);
    limiter.acquireSlot = (owner, signal) => acquire(owner, signal).then((slot) => (grants.push(owner === caseRunSetOf(ra.id) ? "a" : "b"), slot));
    let open!: () => void;
    const gate = new Promise<void>((ok) => (open = ok));
    // Run a's first three requests (all the slots) wait at the gate until run b is queued for a slot.
    const a = provider(() => ({}), { latencyMs: 5 });
    const b = provider(() => ({}), { latencyMs: 5 });
    const tagged = (name: string, m: CasePacketModel, held: boolean): CasePacketModel => ({
      ...m,
      async adjudicate(packet, o) {
        order.push(name);
        if (held) await gate;
        return m.adjudicate(packet, o);
      },
    });
    // Retrieval first (a live run stops for confirmation after it), so the adjudication is all that is timed.
    const [ra, rb] = await Promise.all([1, 2].map(() => createCaseRun(db, caseId, { mode: "live" })));
    for (const r of [ra, rb]) {
      expect(await runCaseRun(db, pool, r.id, deps(null))).toBe("awaiting_confirmation");
      expect(await confirmCaseRun(db, r.id, { budgetUsd: 50 })).toBe("queued");
    }
    const runA = runCaseRun(db, pool, ra.id, deps(tagged("a", a.model, true), { concurrency: 3, limiter }));
    await until(() => order.length === 3 && limiter.inFlight() === 3); // run a holds every slot
    const runB = runCaseRun(db, pool, rb.id, deps(tagged("b", b.model, false), { concurrency: 2, limiter }));
    await until(() => limiter.waitingCount() >= 2); // both of b's lanes wait
    open();
    expect(await Promise.all([runA, runB])).toEqual(["completed", "completed"]);
    // The freed slots went to b, holding none, before a's lanes waiting for their next packet.
    // Slot grants in order: a's three, then the first two freed slots to b (holding none, then one but waiting
    // longer than a's re-queued lanes), then a again.
    expect(grants.slice(0, 5)).toEqual(["a", "a", "a", "b", "b"]);
    expect(limiter.stats.peakInFlight).toBe(3);
    expect(limiter.inFlight()).toBe(0);
    expect(limiter.waitingCount()).toBe(0);
    expect(await fingerprint(ra.id)).toEqual(await fingerprint(sequential));
    expect(await fingerprint(rb.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("never exceeds the budget with requests in flight, and stops only when the budget can't cover the next one", async () => {
    const p = provider(() => ({}), { latencyMs: 10, outputPerPair: 4000 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 1.5, confirmed: true });
    let worst = 0;
    const watch = setInterval(async () => {
      const b = await budgetOf(run.id).catch(() => null);
      if (b) worst = Math.max(worst, b.spentUsd + b.reservedUsd);
    }, 5);
    try {
      expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("blocked_budget");
    } finally {
      clearInterval(watch);
    }
    const b = await budgetOf(run.id);
    expect(worst).toBeLessThanOrEqual(1.5);
    expect(b.reservedUsd).toBe(0); // nothing left held
    const stoppedRun = (await db.select().from(caseRuns).where(eq(caseRuns.id, run.id)))[0];
    const needed = Number(/worst case \(\$([\d.]+)\)/.exec(stoppedRun.error ?? "")?.[1]);
    expect(b.limitUsd - b.spentUsd).toBeLessThan(needed); // with nothing held, genuinely not enough for the next packet
    expect(await duplicates(run.id)).toBe(0);
    const stopped = (await caseRunReport(db, run.id))!;
    expect(stopped.packets.inProgress).toBe(0);
    expect(await resumeCaseRun(db, run.id, { budgetUsd: 50 })).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("completed");
    expect(new Set(p.calls).size).toBe(p.calls.length);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("waits for a settlement instead of stopping when only requests in flight hold the budget", async () => {
    // Replies cost far less than their reserved worst case: a budget that can't hold four reservations at once
    // still covers the whole case, if a lane waits for others to settle rather than giving up.
    const [{ worst, total }] = (await db.execute<{ worst: number; total: number }>(sql`select max(r.max_cost_usd)::float as worst, sum(l.cost_usd)::float as total from adjudication_requests r join llm_calls l on l.id = r.llm_call_id where r.candidate_set = ${caseRunSetOf(sequential)}`)).rows;
    const budgetUsd = Math.ceil((total + 1.5 * worst) * 1e4) / 1e4;
    expect(4 * worst).toBeGreaterThan(budgetUsd); // four lanes can't all hold a reservation
    const p = provider(() => ({}), { latencyMs: 20 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("completed");
    expect(p.state.peak).toBeGreaterThan(1);
    const b = await budgetOf(run.id);
    expect(b.spentUsd).toBeLessThanOrEqual(budgetUsd);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("drains on a graceful shutdown: requests in flight finish, nothing is uncertain, resume completes", async () => {
    const drain = new AbortController();
    const p = provider(() => { if (p.calls.length === 6) drain.abort(); return {}; }, { latencyMs: 30 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4, drain: drain.signal }))).toBe("interrupted");
    const r = (await caseRunReport(db, run.id))!;
    expect(r.requests).toMatchObject({ uncertain: 0, open: 0 });
    expect(r.packets).toMatchObject({ failed: 0, inProgress: 0 });
    expect(r.packets.adjudicated).toBe(p.calls.length); // every request that started was answered and stored
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("completed");
    expect(new Set(p.calls).size).toBe(p.calls.length);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("on a hard shutdown, counts every aborted request as uncertain and never retries it without being asked", async () => {
    const stop = new AbortController();
    const p = provider((_, n) => (p.calls.length > 4 && n === 1 ? { hang: true } : {}), { latencyMs: 5 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    const going = runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4, signal: stop.signal }));
    await until(() => p.state.inFlight === 4);
    stop.abort();
    expect(await going).toBe("interrupted");
    const r = (await caseRunReport(db, run.id))!;
    expect(r.packets).toMatchObject({ failed: 4, uncertain: 4, inProgress: 0 });
    expect(r.requests.open).toBe(0);
    expect(r.cost.budget!.reservedUsd).toBe(0);
    const lost = r.unresolved.map((u) => u.packetId);
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(provider().model, { concurrency: 4 }))).toBe("incomplete");
    expect((await caseRunReport(db, run.id))!.packets).toMatchObject({ failed: 4, uncertain: 4, notStarted: 0 });
    expect(await resumeCaseRun(db, run.id, { retryUncertain: true })).toBe("queued");
    const retry = provider();
    expect(await runCaseRun(db, pool, run.id, deps(retry.model, { concurrency: 4 }))).toBe("completed");
    expect(retry.calls.sort()).toEqual(lost.sort());
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("after an abrupt process death, a new runner settles every request in flight from the database ledger", async () => {
    const dead = new AbortController();
    const p = provider((_, n) => (p.calls.length > 3 && n === 1 ? { hang: true } : {}), { latencyMs: 5 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    const zombie = runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 3, signal: dead.signal })).catch(() => "gone");
    await until(async () => p.state.inFlight === 3 && (await openRequests(run.id)) === 3);
    // The process is gone: its heartbeat stops. Nothing it held in memory is used again.
    await db.update(caseRuns).set({ runnerId: "dead-process", runnerSeenAt: new Date(Date.now() - 120_000) }).where(eq(caseRuns.id, run.id));
    expect(await runCaseRun(db, pool, run.id, deps(provider().model))).toBe("interrupted");
    const r = (await caseRunReport(db, run.id))!;
    expect(r.requests).toMatchObject({ uncertain: 3, open: 0 });
    expect(r.packets).toMatchObject({ failed: 3, uncertain: 3, inProgress: 0 });
    expect(r.cost.budget!.reservedUsd).toBe(0); // the three open reservations were counted in full
    expect(r.cost.budget!.spentUsd).toBeGreaterThan(r.cost.costUsd); // ... on top of what was recorded
    const [owner] = await db.select({ runnerId: caseRuns.runnerId }).from(caseRuns).where(eq(caseRuns.id, run.id));
    expect(owner.runnerId).toBeNull();
    dead.abort();
    await zombie;
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    const after = provider();
    expect(await runCaseRun(db, pool, run.id, deps(after.model, { concurrency: 3 }))).toBe("incomplete");
    expect(after.calls.filter((c) => r.unresolved.some((u) => u.packetId === c))).toHaveLength(0); // never re-sent
    expect(await duplicates(run.id)).toBe(0);
  }, 120_000);

  it("lets every lane finish before a database failure is rethrown, then recovers without paying twice", async () => {
    const p = provider(() => ({}), { latencyMs: 25 });
    let crashed: string | null = null;
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    const failing = deps(p.model, { concurrency: 4, faults: { afterReplyRecorded: (id) => { if (p.calls.length >= 6 && !crashed) { crashed = id; throw new Error("connection terminated"); } } } });
    await expect(runCaseRun(db, pool, run.id, failing)).rejects.toThrow("connection terminated");
    expect(p.state.inFlight).toBe(0); // no lane was still working when the error surfaced
    expect(await openRequests(run.id)).toBe(0);
    const [mid] = await db.select().from(caseRuns).where(eq(caseRuns.id, run.id));
    expect(mid.runnerId).toBeNull();
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("interrupted");
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("completed");
    expect(p.calls.filter((c) => c === crashed)).toHaveLength(1); // its stored reply was parsed, not bought again
    expect(new Set(p.calls).size).toBe(p.calls.length);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("pauses every lane after a 429, retries a bounded number of times, and recovers partial replies once", async () => {
    let skew = 0;
    const limiter = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 4 }, { now: () => Date.now() + skew, sleep: async (ms) => { skew += ms; } });
    const limited = new Set<string>();
    const p = provider((packet, n) => {
      if (n === 1 && limited.size < 5 && !limited.has(packet.id)) {
        limited.add(packet.id);
        return new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers({ "retry-after": "2" }));
      }
      return n === 1 && packet.pairs.length > 1 && !limited.has(packet.id) ? { drop: ["R1"] } : {}; // answered by the recovery request
    }, { latencyMs: 5 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4, limiter }))).toBe("completed");
    expect(limiter.stats.pauses).toBe(5);
    expect(skew).toBeGreaterThanOrEqual(2000); // lanes waited out the retry-after
    const r = (await caseRunReport(db, run.id))!;
    expect(r.requests.failedNotBilled).toBe(5);
    expect(r.requests.uncertain).toBe(0);
    // Each packet: at most its packet request, one recovery request and the rate-limited attempts.
    const perPacket = new Map<string, number>();
    for (const c of p.calls) perPacket.set(c, (perPacket.get(c) ?? 0) + 1);
    expect(Math.max(...perPacket.values())).toBeLessThanOrEqual(2);
    expect(await fingerprint(run.id)).toEqual(await fingerprint(sequential));
  }, 120_000);

  it("admits every request against its max_tokens worst case and refunds down to the actual output", async () => {
    // The limiter's own guarantee (requests in flight never together pass the output limit) is unit-tested in
    // tests/jobs/limiter.test.ts; here, the run must hand it each request's worst case, not an estimate.
    const limiter = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 4 });
    const charged: { output: number; refunded: number }[] = [];
    const reply = limiter.afterReply.bind(limiter);
    limiter.afterReply = (ticket, usage) => { charged.push({ output: ticket.output, refunded: ticket.output - usage.output_tokens }); reply(ticket, usage); };
    const sizes: number[] = [];
    const p = provider((packet) => { sizes.push(maxOutputTokensFor(packet.pairs.length)); return {}; }, { latencyMs: 5 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4, limiter }))).toBe("completed");
    expect(charged.map((c) => c.output).sort()).toEqual(sizes.sort());
    expect(charged.every((c) => c.refunded > 0)).toBe(true); // the mock's replies are far below max_tokens
  }, 120_000);

  it("stops at once on the organization's spend cap, which is not a rate limit", async () => {
    const cap = new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "usage limits", details: { error_code: "enforced_spend_limit_reached" } } }, "usage limits", new Headers());
    const p = provider(() => cap, { latencyMs: 5 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4 }))).toBe("failed");
    expect(p.calls.length).toBeLessThanOrEqual(4); // the lanes in flight, none retried
    const r = (await caseRunReport(db, run.id))!;
    expect(r.requests.uncertain).toBe(0); // a 4xx was never billed
    expect(r.packets.inProgress).toBe(0);
    expect(r.cost.budget!.reservedUsd).toBe(0);
  }, 120_000);

  it("cancels with requests in flight: they finish and are kept, the rest stay pending, no slot is left held", async () => {
    const limiter = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 4 });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    const p = provider(() => {
      if (p.calls.length === 5) void db.update(caseRuns).set({ cancelRequestedAt: new Date() }).where(eq(caseRuns.id, run.id)).then(() => undefined);
      return {};
    }, { latencyMs: 30 });
    expect(await runCaseRun(db, pool, run.id, deps(p.model, { concurrency: 4, limiter }))).toBe("cancelled");
    expect(limiter.inFlight()).toBe(0);
    const r = (await caseRunReport(db, run.id))!;
    expect(r.packets.inProgress).toBe(0);
    expect(r.packets.adjudicated).toBe(p.calls.length);
    expect(r.packets.notStarted).toBeGreaterThan(0);
    expect(r.requests).toMatchObject({ open: 0, uncertain: 0 });
    expect(r.cost.budget!.reservedUsd).toBe(0);
  }, 120_000);
});
