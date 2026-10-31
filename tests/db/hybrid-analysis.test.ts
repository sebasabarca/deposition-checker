// A hybrid analysis end to end, with mock models: cards, topic map, both paths, the union, and pair
// adjudication on the selected candidates. See tests/db/database.ts for when these run.

import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analysisView } from "../../server/src/api/analyses";
import { mockCardModel, mockTopicModel, runDiscovery, withDistractors } from "../../server/src/eval";
import { mockSingle } from "../../server/src/eval/mockModel";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { CARD_EXTRACTOR_VERSION, type ClaimModel } from "../../server/src/claims";
import type { Database } from "../../server/src/db/client";
import { analyses, budgets, candidates, candidateTopics, cardCoverage, depositions, exchanges, llmCalls, statementCards, verdicts } from "../../server/src/db/schema";
import { findPathB, unionCandidates } from "../../server/src/retrieve";
import { analysisCost, candidateSetOf, runAnalysis, type AnalysisProgress } from "../../server/src/jobs";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("hybrid analysis (Postgres, mock models)", () => {
  let db: Database;
  let pool: Pool;
  let depositionIds: number[];

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    ({ depositionIds } = await storeSessions(db, withDistractors(WHITFIELD_SUITE, 40)));
  });

  const create = async (mode: "live" | "demo", { budgetUsd = 3, maxCandidates = 20, status = "queued" as const } = {}) => {
    const [d] = await db.select().from(depositions).where(eq(depositions.id, depositionIds[0]));
    const [a] = await db.insert(analyses).values({ caseId: d.caseId, witnessId: d.witnessId, depositionA: depositionIds[0], depositionB: depositionIds[1], mode, retrieval: "hybrid", promptVersion: "adjudicate-v3", effort: "medium", maxCandidates, budgetUsd, strategy: "C", maxConcurrency: 10, status }).returning();
    const [budget] = await db.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: budgetUsd }).returning();
    await db.update(analyses).set({ budgetId: budget.id }).where(eq(analyses.id, a.id));
    return a.id;
  };
  const rows = (id: number) => db.select().from(candidates).where(eq(candidates.candidateSet, candidateSetOf(id)));
  const deps = (over: { cards?: ClaimModel; topics?: ClaimModel } = {}) => {
    const adjudicator = mockSingle({ timeScale: 0.02 }); // a real latency, so requests overlap
    return { adjudicator, deps: { liveAdjudicator: () => adjudicator, liveCardModels: () => ({ cards: over.cards ?? mockCardModel(), topics: over.topics ?? mockTopicModel() }) } };
  };

  it("goes from testimony to verdicts, one pair per request, ten at a time", async () => {
    const id = await create("live");
    const { adjudicator, deps: d } = deps();
    expect(await runAnalysis(db, id, d)).toBe("completed");
    const stored = await rows(id);
    const selected = stored.filter((c) => c.mergedRank <= 20 && c.selectedBy !== null);
    expect(selected).toHaveLength(20);
    expect(adjudicator.calls).toBe(20);
    expect(adjudicator.peak).toBeGreaterThan(1);
    expect(adjudicator.peak).toBeLessThanOrEqual(10);
    expect(await db.$count(verdicts)).toBe(20);
    expect(stored.every((c) => c.retrievalVersion?.startsWith("hybrid-v1|") && c.mapVersion === 1)).toBe(true);
    expect(stored.every((c) => c.rrfScore === 0)).toBe(true);
    expect(stored.filter((c) => c.status === "adjudicated")).toHaveLength(20);
  });

  it("stores provenance, topics, and every candidate's status", async () => {
    const id = await create("live");
    await runAnalysis(db, id, deps().deps);
    const stored = await rows(id);
    expect(new Set(stored.map((c) => c.sources.join("+")))).toEqual(new Set(["topics", "fulltext", "topics+fulltext"]));
    expect(stored.filter((c) => c.sources.includes("topics")).every((c) => c.rankTopics !== null)).toBe(true);
    expect(stored.every((c) => c.status !== "deferred" || c.deferredReason !== null)).toBe(true);
    expect(stored.filter((c) => c.selectedBy === "path_a").length).toBeGreaterThanOrEqual(11);
    expect(stored.filter((c) => c.selectedBy === "path_b").length).toBeGreaterThanOrEqual(7);
    expect(await db.$count(candidateTopics)).toBeGreaterThan(0);
  });

  it("shows coverage in the analysis view, and counts cards in its cost", async () => {
    const id = await create("live");
    await runAnalysis(db, id, deps().deps);
    const view = (await analysisView(db, id))!;
    expect(view.retrieval).toBe("hybrid");
    expect(view.coverage.candidates.assessed).toBe(20);
    expect(view.coverage.candidates.total).toBe((await rows(id)).length);
    expect(view.coverage.cards![0].cards.sourceGroundingRate).toBe(1);
    expect(view.coverage.topics!.mapVersion).toBe(1);
    const { calls } = await analysisCost(db, (await db.select().from(analyses).where(eq(analyses.id, id)))[0]);
    expect(calls).toBe(await db.$count(llmCalls));
  });

  it("a second analysis reuses cards and the map, calling neither model", async () => {
    await runAnalysis(db, await create("live"), deps().deps);
    const cards = mockCardModel();
    const topics = mockTopicModel();
    await runAnalysis(db, await create("live"), deps({ cards, topics }).deps);
    expect([cards.calls, topics.calls]).toEqual([0, 0]);
  });

  it("if every card call fails, Path B still produces candidates and the run completes", async () => {
    const id = await create("live");
    expect(await runAnalysis(db, id, deps({ cards: mockCardModel({ fail: () => new Error("down") }) }).deps)).toBe("completed");
    const stored = await rows(id);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((c) => c.sources.length === 1 && c.sources[0] === "fulltext")).toBe(true);
    expect(stored.filter((c) => c.selectedBy === "path_b")).toHaveLength(20);
    const progress = (await db.select().from(analyses).where(eq(analyses.id, id)))[0].progress as AnalysisProgress;
    expect(progress.cardsStage).toMatchObject({ cards: 0, topics: "no_cards" });
    expect(progress.cardsStage!.failedChunks).toBeGreaterThan(0);
  });

  it("if only the topic map fails, Path A keeps its entity links", async () => {
    const down: ClaimModel = { model: "claude-haiku-5-5", extract: async () => { throw new Error("down"); } };
    const id = await create("live");
    expect(await runAnalysis(db, id, deps({ topics: down }).deps)).toBe("completed");
    const stored = await rows(id);
    expect(stored.some((c) => c.sources.includes("topics"))).toBe(true);
    expect(stored.every((c) => c.mapVersion === null)).toBe(true);
  });

  it("demo mode never calls a model, and reads whatever cards exist", async () => {
    await runAnalysis(db, await create("live"), deps().deps);
    const before = await db.$count(llmCalls);
    const id = await create("demo");
    expect(await runAnalysis(db, id, { liveAdjudicator: () => { throw new Error("no live call in a demo"); } })).toBe("completed");
    expect(await db.$count(llmCalls)).toBe(before);
    expect((await rows(id)).some((c) => c.sources.includes("topics"))).toBe(true);
  });

  it("a live run with no paid models stops before spending or retrieving", async () => {
    const id = await create("live");
    expect(await runAnalysis(db, id, { liveAdjudicator: () => null })).toBe("blocked_credentials");
    expect(await db.$count(statementCards)).toBe(0);
    expect(await rows(id)).toEqual([]);
  });

  it("a budget stop leaves the rest awaiting assessment, and a raised budget finishes them", async () => {
    const id = await create("live", { budgetUsd: 0.05 });
    const first = await runAnalysis(db, id, deps().deps);
    expect(first).toBe("blocked_budget");
    const view = (await analysisView(db, id))!;
    expect(view.coverage.candidates.awaitingAssessment).toBeGreaterThan(0);
    await db.update(budgets).set({ limitUsd: 3 }).where(eq(budgets.name, `analysis-${id}`));
    await db.update(analyses).set({ status: "queued", budgetUsd: 3 }).where(eq(analyses.id, id));
    const before = (await rows(id)).length;
    const again = deps();
    expect(await runAnalysis(db, id, again.deps)).toBe("completed");
    expect((await rows(id)).length).toBe(before);
    expect((await analysisView(db, id))!.coverage.candidates.awaitingAssessment).toBe(0);
  });

  it("a worker lost mid-retrieval stops a live hybrid run instead of spending again on redelivery", async () => {
    const id = await create("live");
    await db.update(analyses).set({ status: "retrieving" }).where(eq(analyses.id, id));
    const cards = mockCardModel();
    expect(await runAnalysis(db, id, deps({ cards }).deps)).toBe("interrupted");
    expect(cards.calls).toBe(0);
  });

  it("Path B doesn't depend on any extraction result: every status gives the same pairs and pool", async () => {
    const [d] = await db.select().from(depositions).where(eq(depositions.id, depositionIds[1]));
    const before = await findPathB(db, { witnessId: d.witnessId, depositionId: d.id, mode: "rare_terms" });
    expect(before.pairs.length).toBeGreaterThan(0);
    const parts = await db.select({ id: exchanges.id, depositionId: exchanges.depositionId }).from(exchanges);
    for (const status of ["no_assertion", "suspected_omission", "omitted", "failed", "not_processed"] as const) {
      await db.delete(cardCoverage);
      await db.insert(cardCoverage).values(parts.map((p) => ({ exchangeId: p.id, extractorVersion: CARD_EXTRACTOR_VERSION, depositionId: p.depositionId, status, error: status === "failed" ? "x" : null })));
      const after = await findPathB(db, { witnessId: d.witnessId, depositionId: d.id, mode: "rare_terms" });
      expect(after.pairs).toEqual(before.pairs);
      expect(after.counts).toEqual(before.counts);
      const { candidates: pool } = unionCandidates({ fulltext: after.pairs }, { capacity: 5000, perExchangeCap: 5000 });
      expect(pool.every((c) => c.status === "selected")).toBe(true);
    }
  });

  it("a live analysis still finds testimony the model called noAssertion, through Path B", async () => {
    const silent: ClaimModel = { model: "claude-haiku-5-5", extract: async (text) => ({ stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } as never, text: JSON.stringify({ cards: [], noAssertion: [...text.matchAll(/^\[(E\d+)\]$/gm)].map((m) => m[1]) }) }) };
    const id = await create("live");
    expect(await runAnalysis(db, id, deps({ cards: silent }).deps)).toBe("completed");
    const stored = await rows(id);
    expect(stored.filter((c) => c.status === "adjudicated")).toHaveLength(20);
    expect(stored.every((c) => c.sources.join() === "fulltext")).toBe(true);
    expect((await analysisView(db, id))!.coverage.cards![0].coverage.suspected_omission).toBeGreaterThan(0);
  });

  it("useStoredCards retrieves without calling either card model, and retries nothing", async () => {
    await runAnalysis(db, await create("live"), deps().deps);
    const before = await db.$count(llmCalls, sql`stage in ('statement_cards', 'topic_mapping')`);
    const id = await create("live");
    const adjudicator = mockSingle({ timeScale: 0 });
    expect(await runAnalysis(db, id, { liveAdjudicator: () => adjudicator, useStoredCards: true })).toBe("completed");
    expect(await db.$count(llmCalls, sql`stage in ('statement_cards', 'topic_mapping')`)).toBe(before);
    expect((await rows(id)).some((c) => c.sources.includes("topics"))).toBe(true);
  });

  it("re-running a saved analysis keeps one row per pair", async () => {
    const id = await create("live");
    await runAnalysis(db, id, deps().deps);
    const [{ dupes }] = (await db.execute<{ dupes: number }>(sql`select count(*)::int as dupes from (select 1 from candidates group by candidate_set, deposition_a, group_a, deposition_b, group_b having count(*) > 1) x`)).rows;
    expect(dupes).toBe(0);
  });
});

// Development numbers: these suites shaped topic-rank (see docs/agent-log.md), and the mock models
// measure the pipeline, not Haiku. Pinned so a change to retrieval is seen, not to show recall is good.
describe.skipIf(!TEST_DATABASE_URL)("discovery baseline (Postgres, mock models)", () => {
  let db: Database;
  let pool: Pool;
  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(() => emptyTables(db));

  it("discovers Webb's targets with no pair chosen for it", async () => {
    const run = await runDiscovery(db, WEBB_SUITE, { cards: mockCardModel(), topics: mockTopicModel() });
    expect(run).toMatchObject({ synthetic: true });
    expect(run.metrics.found.missed).toEqual([]);
    expect(run.cards.every((c) => c.coverage.not_processed === 0 && c.cards.sourceGroundingRate === 1)).toBe(true);
    expect(run.pool.selected).toBe(30);
  });

  it("Whitfield's paraphrased contradiction is a known miss", async () => {
    const run = await runDiscovery(db, WHITFIELD_SUITE, { cards: mockCardModel(), topics: mockTopicModel() });
    expect(run.metrics.found.missed).toEqual(["whit-fire-location"]);
  });

  it("Path B finds candidates with statement cards switched off", async () => {
    const run = await runDiscovery(db, WHITFIELD_SUITE, { cards: null, topics: null });
    expect(run.pool.pathA + run.pool.both).toBe(0);
    expect(run.pool.pathB).toBeGreaterThan(0);
    expect(run.pool.selectedBy.path_b).toBe(30);
  });
});
