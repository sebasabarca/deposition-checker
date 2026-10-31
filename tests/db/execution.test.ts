// Strategies and interruption end to end against the test database, with the deterministic
// mock model: no request ever leaves this process, which the fetch guard below also checks.

import Anthropic from "@anthropic-ai/sdk";
import { eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAdjudication, STRATEGIES, type StrategyId } from "../../server/src/adjudicate";
import { budgetStatus } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { adjudicationRequests, analyses, budgetReservations, budgets, candidates, depositions, findings, llmCalls, verdicts } from "../../server/src/db/schema";
import { mockSingle, type MockBehaviour } from "../../server/src/eval/mockModel";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { analysisCost, candidateSetOf, runAnalysis, RUNNER_STALE_MS, type AnalysisProgress } from "../../server/src/jobs";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const SET = "all-candidates";
const rateLimit = (seconds: string) => new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers({ "retry-after": seconds }));
const serverError = () => new Anthropic.InternalServerError(500, { type: "error" }, "server error", new Headers());

describe.skipIf(!TEST_DATABASE_URL)("adjudication strategies (Postgres, mock model only)", () => {
  let db: Database;
  let pool: Pool;
  let ids: number[];
  const fetchGuard = vi.fn(() => {
    throw new Error("A test tried to use the network.");
  });

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    vi.stubGlobal("fetch", fetchGuard);
    // 26 candidates: both suites, then a copy of each, so batches of 20 have something to chew on.
    const stored = [
      ...(await storeSynthetic(db, WEBB_SUITE)).values(),
      ...(await storeSynthetic(db, WHITFIELD_SUITE)).values(),
      ...(await storeSynthetic(db, { ...WHITFIELD_SUITE, set: "copy", caseName: "Copy" })).values(),
    ];
    ids = stored.sort((a, b) => a - b);
  });
  afterEach(() => {
    expect(fetchGuard).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  const budget = async (limitUsd = 20) => (await db.insert(budgets).values({ name: `b-${Math.random()}`, limitUsd }).returning())[0].id;
  const run = async (strategy: StrategyId, behaviour: MockBehaviour = {}, over: Partial<Parameters<typeof executeAdjudication>[1]> = {}) => {
    const single = mockSingle(behaviour);
    const budgetId = over.budgetId ?? (await budget());
    const result = await executeAdjudication(db, { candidateSet: SET, candidateIds: ids, strategy, budgetId, single, ...over });
    return { result, single, budgetId };
  };
  const requests = () => db.select().from(adjudicationRequests);
  const verdictRows = () => db.select().from(verdicts);

  it.each(["A", "B", "C"] as const)("strategy %s: one request per candidate, never above its concurrency", async (s) => {
    const { result, single } = await run(s, { timeScale: 0.03 });
    expect(single.calls).toBe(ids.length);
    expect(single.peak).toBe(STRATEGIES[s].maxConcurrency);
    expect(result.peak).toBe(STRATEGIES[s].maxConcurrency);
    expect(await db.$count(findings)).toBe(ids.length);
    const rows = await verdictRows();
    expect(new Set(rows.map((v) => v.candidateId)).size).toBe(ids.length);
    expect(rows.every((v) => v.requestId !== null)).toBe(true);
  });

  it("a rate limit pauses dispatch for its retry-after, releases the reservation, and is not retried", async () => {
    const started = Date.now();
    const { result, single } = await run("B", { fail: (c) => (c === 2 ? rateLimit("1") : null), timeScale: 0.0005 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(single.calls).toBe(ids.length);
    expect(result.rateLimited).toBe(1);
    expect(result.failed).toBe(1);
    expect(await db.$count(verdicts)).toBe(ids.length - 1);
    const [limited] = (await requests()).filter((r) => r.status === "rate_limited");
    expect(limited.errorKind).toBe("rate_limited");
    expect(limited.retryAfterMs).toBe(1000);
    expect((await db.select().from(budgetReservations)).filter((r) => r.status === "released")).toHaveLength(1);
  });

  it("stops after repeated failures, counting possibly billed requests in full", async () => {
    const { result, single, budgetId } = await run("A", { fail: () => serverError() });
    expect(result.stopped).toBe("failures");
    expect(single.calls).toBe(3);
    expect((await budgetStatus(db, budgetId)).reservedUsd).toBe(0);
    expect((await db.select().from(budgetReservations)).every((r) => r.status === "uncertain")).toBe(true);
    expect(await db.$count(llmCalls)).toBe(0);
  });

  it("concurrent requests never exceed the budget, and stop cleanly when it runs out", async () => {
    const budgetId = await budget(0.22);
    const seen: number[] = [];
    const watch = setInterval(() => void budgetStatus(db, budgetId).then((b) => seen.push(b.spentUsd + b.reservedUsd)), 1);
    const { result } = await run("C", { timeScale: 0.01 }, { budgetId });
    clearInterval(watch);
    expect(result.stopped).toBe("budget");
    expect(Math.max(...seen)).toBeLessThanOrEqual(0.22);
    const b = await budgetStatus(db, budgetId);
    expect(b.reservedUsd).toBe(0);
    expect(await db.$count(verdicts)).toBeGreaterThan(5);
    expect(await db.$count(verdicts)).toBeLessThan(ids.length);
  });

  it("a stop reason ends dispatch at once, aborts in-flight requests and counts them in full", async () => {
    let checks = 0;
    const { result, single, budgetId } = await run("B", { timeScale: 0.2 }, { shouldStop: async () => (++checks >= 2 ? "cancelled" : null) });
    expect(result.stopped).toBe("cancelled");
    expect(single.calls).toBeLessThan(ids.length);
    const rows = await requests();
    expect(rows.some((r) => r.status === "aborted")).toBe(true);
    expect((await budgetStatus(db, budgetId)).reservedUsd).toBe(0);
    expect((await db.select().from(budgetReservations)).some((r) => r.status === "uncertain")).toBe(true);
  });

  it("a candidate is never sent twice for the same prompt unless asked", async () => {
    const budgetId = await budget();
    await run("C", {}, { budgetId });
    const again = await run("C", {}, { budgetId });
    expect(again.single.calls).toBe(0);
    expect(await db.$count(verdicts)).toBe(ids.length);
  });

  describe("analysis jobs", () => {
    const create = async (strategy: StrategyId, status: "queued" | "adjudicating" = "queued") => {
      const [c] = await db.select().from(candidates).where(eq(candidates.candidateSet, WEBB_SUITE.set)).limit(1);
      const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
      const s = STRATEGIES[strategy];
      const [a] = await db.insert(analyses).values({ caseId: d.caseId, witnessId: d.witnessId, depositionA: c.depositionA, depositionB: c.depositionB, mode: "live", promptVersion: "adjudicate-v3", effort: "medium", maxCandidates: 300, budgetUsd: 5, status, strategy, candidatesPerRequest: s.candidatesPerRequest, maxConcurrency: s.maxConcurrency }).returning();
      const budgetId = await budget(5);
      await db.update(analyses).set({ budgetId }).where(eq(analyses.id, a.id));
      return { id: a.id, budgetId };
    };
    const load = async (id: number) => (await db.select().from(analyses).where(eq(analyses.id, id)))[0];
    const live = (behaviour: MockBehaviour = {}) => {
      const single = mockSingle(behaviour);
      return { single, deps: { liveAdjudicator: () => single, useStoredCards: true } };
    };

    it("counts each request's cost once", async () => {
      const { id } = await create("C");
      const { deps, single } = live();
      expect(await runAnalysis(db, id, deps)).toBe("completed");
      const a = await load(id);
      const cost = await analysisCost(db, a);
      const [{ total }] = await db.select({ total: sql<number>`sum(cost_usd)::float` }).from(llmCalls);
      expect(cost.calls).toBe(single.calls);
      expect(cost.actualUsd).toBeCloseTo(total, 6);
    });

    it("a restart finds a paid run already adjudicating: it stops, counts the open request, and calls nothing", async () => {
      const { id, budgetId } = await create("B", "adjudicating");
      await db.insert(budgetReservations).values({ budgetId, purpose: "left open", maxUsd: 0.1 });
      await db.update(budgets).set({ reservedUsd: 0.1 }).where(eq(budgets.id, budgetId));
      const { deps, single } = live();
      expect(await runAnalysis(db, id, deps)).toBe("interrupted");
      expect(single.calls).toBe(0);
      const b = await budgetStatus(db, budgetId);
      expect([b.reservedUsd, b.spentUsd]).toEqual([0, 0.1]);
      expect((await load(id)).error).toContain("Resume");
    });

    it("the same restart without paid permission also spends nothing", async () => {
      const { id } = await create("A", "adjudicating");
      expect(await runAnalysis(db, id, { liveAdjudicator: () => null })).toBe("interrupted");
      expect(await db.$count(llmCalls)).toBe(0);
    });

    it("a duplicate delivery leaves a running analysis alone, and each candidate is assessed once", async () => {
      const { id } = await create("B");
      const { deps, single } = live({ timeScale: 0.01 });
      const [first, second] = await Promise.all([runAnalysis(db, id, deps), new Promise((r) => setTimeout(r, 30)).then(() => runAnalysis(db, id, deps))]);
      expect(first).toBe("completed");
      expect(second).toBe("duplicate_delivery");
      const set = await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, candidateSetOf(id)));
      expect(single.calls).toBe(set.length);
      const rows = await db.select().from(verdicts).where(inArray(verdicts.candidateId, set.map((c) => c.id)));
      expect(new Set(rows.map((v) => v.candidateId)).size).toBe(rows.length);
    });

    it("takes over from a runner that has gone silent, as interrupted", async () => {
      const { id } = await create("A", "adjudicating");
      await db.update(analyses).set({ runnerId: "dead", runnerSeenAt: new Date(Date.now() - RUNNER_STALE_MS - 1000) }).where(eq(analyses.id, id));
      expect(await runAnalysis(db, id, live().deps)).toBe("interrupted");
    });

    it("shutdown aborts in-flight requests and records interrupted; a resume finishes only what is left", async () => {
      const { id, budgetId } = await create("B");
      const stop = new AbortController();
      const { deps, single } = live({ timeScale: 0.05, fail: (c) => (c === 2 ? (stop.abort(), null) : null) });
      expect(await runAnalysis(db, id, { ...deps, signal: stop.signal })).toBe("interrupted");
      const a = await load(id);
      expect((await budgetStatus(db, budgetId)).reservedUsd).toBe(0);
      const assessed = await db.$count(verdicts);
      expect(single.calls).toBeLessThan((a.progress as AnalysisProgress).candidates!.selected);

      await db.update(analyses).set({ status: "queued", error: null, finishedAt: null }).where(eq(analyses.id, id));
      const resumed = live();
      expect(await runAnalysis(db, id, resumed.deps)).toBe("completed");
      expect(await db.$count(verdicts)).toBe(assessed + resumed.single.calls);
      expect(((await load(id)).progress as AnalysisProgress).adjudicated).toBe((await db.$count(verdicts)));
    });

    it("a cancel request stops the run within a check, and keeps its findings", async () => {
      const { id } = await create("A");
      const { deps } = live({ timeScale: 0.1, fail: (c) => { if (c === 1) void db.update(analyses).set({ cancelRequestedAt: new Date() }).where(eq(analyses.id, id)).then(() => null); return null; } });
      expect(await runAnalysis(db, id, deps)).toBe("cancelled");
      expect((await load(id)).runnerId).toBeNull();
    });

    it("an explicit retry sends candidates with an invalid verdict again; a normal resume doesn't", async () => {
      const { id } = await create("A");
      const first = live({ stopReason: (c) => (c === 1 ? "max_tokens" : "end_turn") });
      await runAnalysis(db, id, first.deps);
      const again = async (retryInvalid: boolean) => {
        await db.update(analyses).set({ status: "queued", finishedAt: null, progress: sql`${analyses.progress} || ${JSON.stringify({ retryInvalid })}::jsonb` }).where(eq(analyses.id, id));
        const next = live();
        await runAnalysis(db, id, next.deps);
        return next.single.calls;
      };
      expect(await again(false)).toBe(0);
      expect(await again(true)).toBe(1);
    });
  });
});
