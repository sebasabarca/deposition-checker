// The analysis job end to end against the test database, with synthetic depositions and fake or no
// models: no API call is ever made. See tests/db/database.ts for when these run.

import type Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adjudicateCandidate, loadPacket, type Adjudicator, type Verdict } from "../../server/src/adjudicate";
import { budgetStatus } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { analyses, budgetReservations, budgets, candidates, depositions, findings, llmCalls, verdicts } from "../../server/src/db/schema";
import { SYNTHETIC_CASES, WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { analysisCost, candidateSetOf, paidCallsAllowed, runAnalysis, type AnalysisDeps, type AnalysisProgress } from "../../server/src/jobs";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const usage = { input_tokens: 900, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null } as unknown as Anthropic.Usage;

// A fake model that answers each packet with a schema-valid false positive, citing its own IDs.
function fakeModel(behaviour: "answer" | "throw" | "invalid" = "answer", outputTokens = 400): Adjudicator & { calls: number } {
  const model = {
    model: "claude-sonnet-5-5",
    effort: "medium" as const,
    promptVersion: "adjudicate-v1" as const,
    calls: 0,
    async adjudicate(packetText: string) {
      model.calls++;
      if (behaviour === "throw") throw new Error("socket hang up");
      const [a, b] = [...packetText.matchAll(/Exchange \[(E\d+)\]/g)].map((m) => m[1]);
      const text =
        behaviour === "invalid"
          ? "not json"
          : JSON.stringify({
              classification: "insufficient_evidence", evidenceAId: a, evidenceBId: b, keyPhraseA: "zzz", keyPhraseB: "zzz",
              attributionA: "unclear", attributionB: "unclear", stanceA: "unclear", stanceB: "unclear", sameEvent: "uncertain", scopeAligned: "uncertain",
              conflictBasis: "none", aboutTimingOfSameEvent: false, inferenceSteps: [], unestablishedAssumptions: [], falsePositiveReason: null,
              explanation: "fake", alternativeExplanation: null, needsMoreContext: true,
            });
      return { model: "claude-sonnet-5-5", stopReason: "end_turn", usage: { ...usage, output_tokens: outputTokens }, text, latencyMs: 5 };
    },
  };
  return model;
}
const neverCalled: AnalysisDeps = { liveAdjudicator: () => { throw new Error("a demo analysis asked for a model"); } };

describe.skipIf(!TEST_DATABASE_URL)("analysis jobs (Postgres, no model calls)", () => {
  let pool: Pool;
  let db: Database;
  let fixtureIds: Map<string, number>;
  let depA: number;
  let depB: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    fixtureIds = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, fixtureIds.get("webb-cho")!));
    depA = c.depositionA;
    depB = c.depositionB;
  });

  const create = async (mode: "demo" | "live", budgetUsd = 3, maxCandidates = 300) => {
    const [d] = await db.select().from(depositions).where(eq(depositions.id, depA));
    const [a] = await db.insert(analyses).values({ caseId: d.caseId, witnessId: d.witnessId, depositionA: depA, depositionB: depB, mode, promptVersion: "adjudicate-v1", effort: "medium", maxCandidates, budgetUsd }).returning();
    const [budget] = await db.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: budgetUsd }).returning();
    await db.update(analyses).set({ budgetId: budget.id }).where(eq(analyses.id, a.id));
    return a.id;
  };
  const load = async (id: number) => (await db.select().from(analyses).where(eq(analyses.id, id)))[0];
  const setFindings = async (id: number) =>
    db.select({ f: findings, v: verdicts }).from(findings).innerJoin(verdicts, eq(verdicts.id, findings.verdictId)).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, candidateSetOf(id)));

  it("never allows paid calls without both a key and ALLOW_PAID_CALLS=true", () => {
    expect(paidCallsAllowed({})).toBe(false);
    expect(paidCallsAllowed({ ANTHROPIC_API_KEY: "k" })).toBe(false);
    expect(paidCallsAllowed({ ANTHROPIC_API_KEY: "k", ALLOW_PAID_CALLS: "1" })).toBe(false);
    expect(paidCallsAllowed({ ALLOW_PAID_CALLS: "true" })).toBe(false);
    expect(paidCallsAllowed({ ANTHROPIC_API_KEY: "k", ALLOW_PAID_CALLS: "true" })).toBe(true);
  });

  it("demo: retrieves, replays stored model verdicts and fixtures, counts the rest, and never calls a model", async () => {
    // A stored model verdict for the Cho pair, as an earlier paid run would have left.
    const cho = SYNTHETIC_CASES.find((c) => c.id === "webb-cho")!;
    const packet = await loadPacket(db, fixtureIds.get("webb-cho")!);
    const stored: Adjudicator = { ...fakeModel(), async adjudicate() { return { model: "claude-sonnet-5-5", stopReason: "end_turn", usage, text: JSON.stringify({ ...cho.verdict, evidenceAId: packet.a.id, evidenceBId: packet.b.id }), latencyMs: 1 }; } };
    await adjudicateCandidate(db, fixtureIds.get("webb-cho")!, stored, { budgetId: (await db.insert(budgets).values({ name: "earlier", limitUsd: 1 }).returning())[0].id });
    const callsBefore = await db.$count(llmCalls);

    const id = await create("demo");
    expect(await runAnalysis(db, id, neverCalled)).toBe("completed");
    const a = await load(id);
    const p = a.progress as AnalysisProgress;
    expect(p.candidates!.selected).toBeGreaterThanOrEqual(5);
    expect(p.replayed).toBe(1);
    expect(p.fixture).toBe(4); // home, pizza, sleep, hargrove: found by retrieval, prepared verdicts
    expect(p.withoutVerdict).toBe(p.candidates!.selected - 5);
    expect(p.findings).toBe(5);
    const rows = await setFindings(id);
    expect(rows.map((r) => r.v.origin).sort()).toEqual(["fixture", "fixture", "fixture", "fixture", "replayed"]);
    expect(rows.every((r) => r.v.llmCallId === null)).toBe(true);
    expect(await db.$count(llmCalls)).toBe(callsBefore);
    expect((await analysisCost(db, a)).actualUsd).toBe(0);
  });

  it("demo: the same PDFs uploaded to another case replay the stored verdict, citing the new exchanges", async () => {
    const cho = SYNTHETIC_CASES.find((c) => c.id === "webb-cho")!;
    const original = await loadPacket(db, fixtureIds.get("webb-cho")!);
    const stored: Adjudicator = { ...fakeModel(), async adjudicate() { return { model: "claude-sonnet-5-5", stopReason: "end_turn", usage, text: JSON.stringify({ ...cho.verdict, evidenceAId: original.a.id, evidenceBId: original.b.id }), latencyMs: 1 }; } };
    await adjudicateCandidate(db, fixtureIds.get("webb-cho")!, stored, { budgetId: (await db.insert(budgets).values({ name: "earlier", limitUsd: 1 }).returning())[0].id });
    const callsBefore = await db.$count(llmCalls);

    // The same files in a new case: new deposition, line and exchange IDs, same hashes.
    const copy = await storeSynthetic(db, { ...WEBB_SUITE, set: "webb-copy", caseName: "Copy of Webb" });
    const [c] = await db.select().from(candidates).where(eq(candidates.id, copy.get("webb-cho")!));
    expect(c.depositionA).not.toBe(depA);
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    const [a] = await db.insert(analyses).values({ caseId: d.caseId, witnessId: d.witnessId, depositionA: c.depositionA, depositionB: c.depositionB, mode: "demo", promptVersion: "adjudicate-v1", effort: "medium", maxCandidates: 300, budgetUsd: 1 }).returning();
    expect(await runAnalysis(db, a.id, neverCalled)).toBe("completed");

    const rows = await setFindings(a.id);
    expect(rows.map((r) => r.v.origin)).toEqual(["replayed"]);
    const parsed = rows[0].v.parsed as Verdict;
    const packet = rows[0].v.packet as { sides: { id: string }[] };
    expect([parsed.evidenceAId, parsed.evidenceBId]).toEqual([packet.sides[0].id, packet.sides[1].id]);
    expect(parsed.evidenceAId).not.toBe(original.a.id);
    expect(["verified", "approximate"]).toContain(rows[0].f.evidenceStatus);
    expect(await db.$count(llmCalls)).toBe(callsBefore);
  });

  it("demo: never replays a batch experiment verdict", async () => {
    const packet = await loadPacket(db, fixtureIds.get("webb-cho")!);
    const cho = SYNTHETIC_CASES.find((c) => c.id === "webb-cho")!;
    const parsed = { ...cho.verdict, evidenceAId: packet.a.id, evidenceBId: packet.b.id, explanation: "placeholder" };
    const [call] = await db.insert(llmCalls).values({ stage: "adjudication", model: "claude-sonnet-5-5", items: 1, inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, attempt: 1 }).returning();
    await db.insert(verdicts).values({ candidateId: fixtureIds.get("webb-cho")!, model: "claude-sonnet-5-5", promptVersion: "adjudicate-batch-v1", effort: "medium", status: "valid", raw: "{}", parsed, packet: {}, origin: "model", llmCallId: call.id });
    const id = await create("demo");
    await runAnalysis(db, id, neverCalled);
    expect((await setFindings(id)).every((r) => r.v.origin === "fixture")).toBe(true);
  });

  it("is idempotent: running a finished or interrupted analysis again adds nothing", async () => {
    const id = await create("demo");
    await runAnalysis(db, id, neverCalled);
    const before = { verdicts: await db.$count(verdicts), findings: await db.$count(findings), candidates: await db.$count(candidates) };
    expect(await runAnalysis(db, id, neverCalled)).toBe("completed");
    // As if the worker crashed mid-adjudication and pg-boss redelivered the job.
    await db.update(analyses).set({ status: "adjudicating" }).where(eq(analyses.id, id));
    expect(await runAnalysis(db, id, neverCalled)).toBe("completed");
    expect({ verdicts: await db.$count(verdicts), findings: await db.$count(findings), candidates: await db.$count(candidates) }).toEqual(before);
  });

  it("live without credentials: blocked before any call or retrieval", async () => {
    const id = await create("live");
    expect(await runAnalysis(db, id, { liveAdjudicator: () => null })).toBe("blocked_credentials");
    const a = await load(id);
    expect(a.error).toMatch(/ALLOW_PAID_CALLS/);
    expect((a.progress as AnalysisProgress).candidates).toBeUndefined();
    expect(await db.$count(llmCalls)).toBe(0);
  });

  it("live: adjudicates every selected candidate under the budget and reports the recorded cost", async () => {
    const model = fakeModel();
    const id = await create("live", 3, 4);
    expect(await runAnalysis(db, id, { liveAdjudicator: () => model, useStoredCards: true })).toBe("completed");
    const a = await load(id);
    expect((a.progress as AnalysisProgress).adjudicated).toBe(4);
    expect(model.calls).toBe(4);
    const cost = await analysisCost(db, a);
    const [sum] = (await db.execute<{ s: string }>(sql`select sum(cost_usd) as s from llm_calls`)).rows;
    expect(cost.actualUsd).toBeCloseTo(Number(sum.s), 8);
    expect(cost.budget!.spentUsd).toBeCloseTo(cost.actualUsd, 8);
  });

  it("live: stops before a call the budget can't cover, keeps completed work, and resumes with more budget", async () => {
    // Each call reserves about $0.09 and, at 7,000 output tokens, costs about $0.07: after the first,
    // the next worst case no longer fits in $0.15.
    const model = fakeModel("answer", 7000);
    const id = await create("live", 0.15, 4);
    expect(await runAnalysis(db, id, { liveAdjudicator: () => model, useStoredCards: true })).toBe("blocked_budget");
    expect(model.calls).toBe(1);
    expect((await setFindings(id)).length).toBe(1);
    const a = await load(id);
    await db.update(budgets).set({ limitUsd: 1 }).where(eq(budgets.id, a.budgetId!));
    await db.update(analyses).set({ status: "queued" }).where(eq(analyses.id, id));
    expect(await runAnalysis(db, id, { liveAdjudicator: () => model, useStoredCards: true })).toBe("completed");
    expect(model.calls).toBe(4); // the first candidate isn't adjudicated again
    expect((await budgetStatus(db, a.budgetId!)).reservedUsd).toBe(0);
  });

  it("live: an invalid model response is stored and counted, and never retried automatically", async () => {
    const model = fakeModel("invalid");
    const id = await create("live", 3, 2);
    expect(await runAnalysis(db, id, { liveAdjudicator: () => model, useStoredCards: true })).toBe("completed");
    expect((await db.select().from(verdicts)).map((v) => v.status)).toEqual(["schema_invalid", "schema_invalid"]);
    expect(await db.$count(findings)).toBe(0);
    await db.update(analyses).set({ status: "adjudicating" }).where(eq(analyses.id, id));
    await runAnalysis(db, id, { liveAdjudicator: () => model, useStoredCards: true });
    expect(model.calls).toBe(2);
  });

  it("live: fails after repeated call failures, counting each possibly billed request in full", async () => {
    const model = fakeModel("throw");
    const id = await create("live", 3, 10);
    expect(await runAnalysis(db, id, { liveAdjudicator: () => model, useStoredCards: true })).toBe("failed");
    expect(model.calls).toBe(3);
    const a = await load(id);
    expect(a.error).toMatch(/3 model calls failed in a row/);
    const reservations = await db.select().from(budgetReservations);
    expect(reservations.map((r) => r.status)).toEqual(["uncertain", "uncertain", "uncertain"]);
  });

  it("waits while a deposition is still being read, and fails if one can't be used", async () => {
    await db.update(depositions).set({ status: "processing" }).where(eq(depositions.id, depB));
    const id = await create("demo");
    expect(await runAnalysis(db, id, neverCalled)).toBe("waiting");
    expect((await load(id)).status).toBe("parsing");
    await db.update(depositions).set({ status: "ready" }).where(eq(depositions.id, depB));
    expect(await runAnalysis(db, id, neverCalled)).toBe("completed");

    await db.update(depositions).set({ status: "unsupported" }).where(eq(depositions.id, depB));
    const failing = await create("demo");
    expect(await runAnalysis(db, failing, neverCalled)).toBe("failed");
    expect((await load(failing)).error).toMatch(/unsupported/);
  });
});
