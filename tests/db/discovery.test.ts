// A direct analysis end to end, with a mock provider and no paid call: submit, poll, verify, store,
// and every way a request can go wrong. See tests/db/database.ts for when these run.
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advanceDiscovery, DISCOVERY_FALLBACK_MODEL, DISCOVERY_MODEL, MAX_POLL_FAILURES, type DiscoveryProvider, type DiscoveryRequest, type DiscoveryResult } from "../../server/src/adjudicate";
import { analysisFindings, analysisView, findingDetail } from "../../server/src/api/analyses";
import { withDistractors } from "../../server/src/eval";
import { WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import type { Database } from "../../server/src/db/client";
import { analyses, budgetReservations, budgets, depositions, discoveryRuns, findings, lines, llmCalls } from "../../server/src/db/schema";
import { runAnalysis, type RunOutcome } from "../../server/src/jobs";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const USAGE = { input_tokens: 134000, output_tokens: 13000, output_tokens_details: { thinking_tokens: 12000 } };
const output = (findingsList: unknown[]) => JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: findingsList });
const success = (text: string, model = DISCOVERY_MODEL): DiscoveryResult => ({ type: "succeeded", message: { model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: USAGE } as never });
const refusal = (usage = USAGE): DiscoveryResult => ({ type: "succeeded", message: { model: DISCOVERY_MODEL, stop_reason: "refusal", stop_details: { category: "reasoning_extraction", explanation: "blocked" }, content: [], usage } as never });

function mockProvider(results: DiscoveryResult[], { ready = 1 } = {}) {
  const sent: DiscoveryRequest[] = [];
  const cancelled: string[] = [];
  let polls = 0;
  const provider: DiscoveryProvider = {
    submit: async (r) => {
      sent.push(r);
      return { batchId: `batch-${sent.length}` };
    },
    poll: async () => ({ ended: ++polls >= ready, latencyMs: 400000 }),
    result: async (batchId) => {
      polls = 0;
      return results[Number(batchId.split("-")[1]) - 1];
    },
    cancel: async (id) => void cancelled.push(id),
  };
  return { provider, sent, cancelled };
}

describe.skipIf(!TEST_DATABASE_URL)("direct analysis (Postgres, mock provider)", () => {
  let db: Database;
  let pool: Pool;
  let depositionIds: number[];
  let witness: string;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    ({ depositionIds } = await storeSessions(db, withDistractors(WHITFIELD_SUITE, 5)));
    witness = WHITFIELD_SUITE.witness;
  });

  const create = async (budgetUsd = 6) => {
    const [d] = await db.select().from(depositions).where(eq(depositions.id, depositionIds[0]));
    const [a] = await db.insert(analyses).values({ caseId: d.caseId, witnessId: d.witnessId, depositionA: depositionIds[0], depositionB: depositionIds[1], mode: "live", retrieval: "direct_fable", promptVersion: "discover-v1", effort: "xhigh", maxCandidates: 1, budgetUsd }).returning();
    const [budget] = await db.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: budgetUsd }).returning();
    await db.update(analyses).set({ budgetId: budget.id }).where(eq(analyses.id, a.id));
    return a.id;
  };
  const step = (id: number, provider: DiscoveryProvider) => runAnalysis(db, id, { liveAdjudicator: () => null, discovery: () => provider });
  async function finish(id: number, provider: DiscoveryProvider): Promise<RunOutcome> {
    for (let i = 0; i < 12; i++) {
      const outcome = await step(id, provider);
      if (outcome !== "polling") return outcome;
    }
    throw new Error("still polling");
  }
  const stored = async (depositionId: number) => (await db.select().from(lines).where(eq(lines.depositionId, depositionId))).sort((x, y) => x.printedPage - y.printedPage || x.lineNo - y.lineNo);
  const ref = (l: { printedPage: number; lineNo: number }) => `${l.printedPage}:${String(l.lineNo).padStart(2, "0")}`;
  // A finding quoting real witness lines of each session.
  async function realFinding(over = {}, nth = 0) {
    const [a, b] = [await stored(depositionIds[0]), await stored(depositionIds[1])];
    const pick = (ls: typeof a) => ls.filter((l) => l.speakerRole === "witness" && l.rawText.replace(/^A\.\s*/, "").length > 10)[nth];
    const [x, y] = [pick(a), pick(b)];
    return { finding_id: `F${nth}`, witness, session_a: "A", citation_a: ref(x), exact_excerpt_a: x.rawText.replace(/^A\.\s*/, ""), session_b: "B", citation_b: ref(y), exact_excerpt_b: y.rawText.replace(/^A\.\s*/, ""), shared_subject: "s", comparable: "yes", classification: "direct_contradiction", factual_proposition_a: "pa", factual_proposition_b: "pb", conflict_basis: "c", explanation: "e", alternative_explanation: "alt", missing_context: "", confidence_rationale: "r", ...over };
  }

  it("runs a normal result through verification into the workbench's rows", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([success(output([await realFinding()]))], { ready: 2 });
    expect(await step(id, provider)).toBe("polling"); // submitted
    expect(await step(id, provider)).toBe("polling"); // not ended
    expect(await step(id, provider)).toBe("completed");
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe(DISCOVERY_MODEL);
    const { groups, notStored } = await analysisFindings(db, id);
    expect(groups.find((g) => g.group === "contradictions")?.findings).toHaveLength(1);
    expect(notStored).toEqual([]);
    const row = groups[0].findings[0];
    expect(row).toMatchObject({ model: DISCOVERY_MODEL, modelName: "Veridict's analysis", source: "model" });
    expect(row.score).toEqual(expect.any(Number)); // evidence strength, from stored facts only
    expect(row.priority).toBe("high"); // direct, one subject, plain assertions
    const detail = (await findingDetail(db, row.id))!;
    expect(detail.rubricVersion).toBe("evidence-strength-v1");
    expect(detail.factors).toHaveLength(5);
    expect(detail.a.lines.length).toBeGreaterThan(0);
    expect(detail.source.label).toContain("Veridict's analysis");
    expect(detail.source.label).not.toMatch(/Claude|Anthropic|Fable/);
    expect(detail.a.lines[0].text).toBe((await stored(depositionIds[0])).find((l) => ref(l) === detail.a.lines[0].ref)?.rawText); // quotations are stored lines
    const view = (await analysisView(db, id))!;
    expect(view.status).toBe("completed");
    expect(view.discovery).toMatchObject({ resultModel: DISCOVERY_MODEL, usedFallback: false });
    expect(view.discovery!.attempts[0]).toMatchObject({ status: "succeeded", stopReason: "end_turn", thinkingTokens: 12000, latencyMs: 400000 });
    expect(view.discovery!.sourceHashes).toMatchObject({ prompt: expect.any(String) });
    expect(view.cost.actualUsd).toBeCloseTo((134000 * 5 + 13000 * 25) / 1e6, 5); // batch rates
  });

  it("treats zero findings as a result, with no fallback", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([success(output([]))]);
    expect(await finish(id, provider)).toBe("completed");
    expect(sent).toHaveLength(1);
    expect((await analysisView(db, id))!.findings.total).toBe(0);
  });

  it("falls back once after an explicit refusal, and labels whose findings they are", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([refusal(), success(output([await realFinding()]), DISCOVERY_FALLBACK_MODEL)]);
    expect(await finish(id, provider)).toBe("completed");
    expect(sent.map((r) => r.model)).toEqual([DISCOVERY_MODEL, DISCOVERY_FALLBACK_MODEL]);
    const view = (await analysisView(db, id))!;
    expect(view.discovery).toMatchObject({ usedFallback: true, resultModelName: "Veridict's second reading" });
    expect(view.discovery!.attempts.map((r) => [r.status, r.refusalCategory])).toEqual([["refused", "reasoning_extraction"], ["succeeded", null]]);
    expect(await db.$count(llmCalls)).toBe(2); // the refused attempt's cost is recorded too
    const { groups } = await analysisFindings(db, id);
    const detail = (await findingDetail(db, groups[0].findings[0].id))!;
    expect(detail.source.model).toBe(DISCOVERY_FALLBACK_MODEL);
    expect(detail.source.label).toContain("after the first reading declined");
  });

  it("stops after a failed fallback, with no third request", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([refusal(), refusal()]);
    expect(await finish(id, provider)).toBe("failed");
    expect(sent).toHaveLength(2);
    expect((await analysisView(db, id))!.error).toContain("refused");
  });

  it("stops before a fallback the budget can't cover", async () => {
    const id = await create(1.9); // covers the first request's worst case; the refusal then uses most of it
    const { provider, sent } = mockProvider([refusal({ ...USAGE, output_tokens: 40000 })]);
    const outcome = await finish(id, provider);
    expect(outcome).toBe("blocked_budget");
    expect(sent).toHaveLength(1);
    expect((await analysisView(db, id))!.error).toContain("fallback");
    const [b] = await db.select().from(budgets);
    expect(b.spentUsd + b.reservedUsd).toBeLessThanOrEqual(b.limitUsd);
  });

  it("sends nothing when the budget can't cover the first request", async () => {
    const id = await create(0.001);
    const { provider, sent } = mockProvider([success(output([]))]);
    expect(await finish(id, provider)).toBe("blocked_budget");
    expect(sent).toHaveLength(0);
  });

  it("fails a malformed answer without a fallback, keeping what came back", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([success("not json")]);
    expect(await finish(id, provider)).toBe("failed");
    expect(sent).toHaveLength(1);
    const [run] = await db.select().from(discoveryRuns);
    expect(run.status).toBe("invalid_output");
    expect((await db.select().from(llmCalls))[0].rawOutput).toBe("not json");
  });

  it("doesn't fall back on a cut-off answer or a provider failure", async () => {
    const id = await create();
    const cut = mockProvider([{ type: "succeeded", message: { model: DISCOVERY_MODEL, stop_reason: "max_tokens", content: [], usage: USAGE } as never }]);
    expect(await finish(id, cut.provider)).toBe("failed");
    expect(cut.sent).toHaveLength(1);
    expect((await db.select().from(discoveryRuns))[0].status).toBe("incomplete");
    const next = await create();
    const failed = mockProvider([{ type: "errored", error: "overloaded" }]);
    expect(await finish(next, failed.provider)).toBe("failed");
    expect(failed.sent).toHaveLength(1);
  });

  it("releases the reservation of an expired batch, which wasn't billed", async () => {
    const id = await create();
    expect(await finish(id, mockProvider([{ type: "expired" }]).provider)).toBe("failed");
    const [r] = await db.select().from(budgetReservations);
    expect(r.status).toBe("released");
    expect((await db.select().from(budgets))[0].spentUsd).toBe(0);
  });

  it("picks the batch back up after a worker restart, without a second request", async () => {
    const id = await create();
    const first = mockProvider([], { ready: 99 });
    expect(await step(id, first.provider)).toBe("polling");
    expect(first.sent).toHaveLength(1);
    await db.update(analyses).set({ runnerId: "dead", runnerSeenAt: new Date(0) }).where(eq(analyses.id, id)); // the worker died mid-job
    const restarted: DiscoveryProvider = { ...mockProvider([success(output([]))]).provider, submit: async () => { throw new Error("a restart must never submit"); }, result: async () => success(output([])) };
    expect(await finish(id, restarted)).toBe("completed");
    expect(await db.$count(discoveryRuns)).toBe(1);
  });

  it("delivering a finished result twice stores it once", async () => {
    const id = await create();
    const { provider } = mockProvider([success(output([await realFinding()]))]);
    expect(await finish(id, provider)).toBe("completed");
    await db.update(analyses).set({ status: "adjudicating", finishedAt: null }).where(eq(analyses.id, id));
    expect(await finish(id, provider)).toBe("completed");
    expect(await db.$count(findings)).toBe(1);
    expect(await db.$count(llmCalls)).toBe(1);
  });

  it("sends nothing more if a worker died while submitting", async () => {
    const id = await create();
    const [a] = await db.select().from(analyses).where(eq(analyses.id, id));
    await db.insert(discoveryRuns).values({ analysisId: id, attempt: 1, role: "primary", model: DISCOVERY_MODEL, promptVersion: "discover-v1", effort: "xhigh", maxOutputTokens: 64000, status: "submitting", customId: "x", maxCostUsd: 1, sourceHashes: {} });
    const { provider, sent } = mockProvider([]);
    expect(await step(id, provider)).toBe("interrupted");
    expect(sent).toHaveLength(0);
    expect((await db.select().from(discoveryRuns))[0].status).toBe("submission_unknown");
    expect(a.status).toBe("queued");
  });

  it("cancels the provider's batch, and records what it left", async () => {
    const id = await create();
    const { provider, cancelled } = mockProvider([{ type: "canceled" }], { ready: 3 });
    expect(await step(id, provider)).toBe("polling");
    await db.update(analyses).set({ cancelRequestedAt: new Date() }).where(eq(analyses.id, id));
    expect(await step(id, provider)).toBe("polling");
    expect(cancelled).toEqual(["batch-1"]);
    expect(await finish(id, provider)).toBe("cancelled");
    expect((await db.select().from(budgetReservations))[0].status).toBe("released");
  });

  it("keeps polling through a short provider outage, and still gets the result", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([success(output([]))]);
    let outages = 3;
    const flaky: DiscoveryProvider = { ...provider, poll: async (b) => { if (outages-- > 0) throw new Error("503"); return provider.poll(b); } };
    expect(await finish(id, flaky)).toBe("completed");
    expect(sent).toHaveLength(1);
    expect((await db.select().from(budgetReservations))[0].status).toBe("settled");
    expect((await analysisView(db, id))!.progress).toMatchObject({ pollFailures: 0 });
  });

  it.each(["poll", "result"] as const)("closes the run after repeated %s failures, counting the reservation in full", async (method) => {
    const id = await create();
    const { provider, sent } = mockProvider([success(output([]))]);
    const down: DiscoveryProvider = { ...provider, [method]: async () => { throw new Error("provider down"); } };
    let outcome: RunOutcome = "polling";
    for (let i = 0; i <= MAX_POLL_FAILURES && outcome === "polling"; i++) outcome = await step(id, down);
    expect(outcome).toBe("failed");
    expect(sent).toHaveLength(1);
    const [[run], [reservation], [budget]] = [await db.select().from(discoveryRuns), await db.select().from(budgetReservations), await db.select().from(budgets)];
    expect([run.status, reservation.status]).toEqual(["provider_failed", "uncertain"]);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.spentUsd).toBe(reservation.maxUsd);
    expect((await analysisView(db, id))!.error).toContain("may have run and been billed");
  });

  it("offers a resume only when it can make progress", async () => {
    const stopped = await create(0.001);
    await finish(stopped, mockProvider([]).provider);
    expect((await analysisView(db, stopped))!.resumable).toBe(true);
    const failed = await create();
    await finish(failed, mockProvider([success("not json")]).provider);
    expect((await analysisView(db, failed))!.resumable).toBe(false);
  });

  it("sends nothing if Stop arrives after the job read the analysis", async () => {
    const id = await create();
    const [stale] = await db.select().from(analyses).where(eq(analyses.id, id));
    await db.update(analyses).set({ cancelRequestedAt: new Date() }).where(eq(analyses.id, id));
    const { provider, sent } = mockProvider([]);
    expect(await advanceDiscovery(db, stale, provider)).toMatchObject({ outcome: "cancelled" });
    expect(sent).toHaveLength(0);
    expect(await db.$count(discoveryRuns)).toBe(0);
    expect(await db.$count(budgetReservations)).toBe(0);
  });

  it("sends no fallback if Stop arrives after the refusal", async () => {
    const id = await create();
    const { provider, sent } = mockProvider([refusal()]);
    expect(await step(id, provider)).toBe("polling");
    const [stale] = await db.select().from(analyses).where(eq(analyses.id, id));
    const during: DiscoveryProvider = { ...provider, result: async (b, c) => {
      await db.update(analyses).set({ cancelRequestedAt: new Date() }).where(eq(analyses.id, id));
      return provider.result(b, c);
    } };
    expect(await advanceDiscovery(db, stale, during)).toMatchObject({ outcome: "cancelled" });
    expect(sent).toHaveLength(1);
  });

  it("stops at blocked_credentials with no provider", async () => {
    const id = await create();
    expect(await runAnalysis(db, id, { liveAdjudicator: () => null })).toBe("blocked_credentials");
  });

  it("keeps failed verification for audit, in the unverified lane or the audit list", async () => {
    const id = await create();
    const good = await realFinding();
    const invented = { ...(await realFinding({}, 1)), finding_id: "F-bad", exact_excerpt_a: "words nobody ever said in this deposition at all" };
    const lost = { ...(await realFinding({}, 2)), finding_id: "F-lost", citation_a: "9999:01" };
    const { provider } = mockProvider([success(output([good, invented, lost]))]);
    expect(await finish(id, provider)).toBe("completed");
    const { groups, notStored } = await analysisFindings(db, id);
    expect(groups.find((g) => g.group === "contradictions")?.findings).toHaveLength(1);
    expect(groups.find((g) => g.group === "unverified")?.findings).toHaveLength(1);
    expect(notStored.map((n) => n.findingId)).toEqual(["F-lost"]);
    const [run] = await db.select().from(discoveryRuns);
    expect((run.audit as unknown[]).length).toBe(3);
  });

  it("shows duplicates once, keeping the originals on the finding", async () => {
    const id = await create();
    const f = await realFinding();
    const copy = { ...f, finding_id: "F-copy", session_a: "B", citation_a: f.citation_b, exact_excerpt_a: f.exact_excerpt_b, session_b: "A", citation_b: f.citation_a, exact_excerpt_b: f.exact_excerpt_a, classification: "uncertain_needs_context" };
    const { provider } = mockProvider([success(output([f, copy, await realFinding({}, 3)]))]);
    expect(await finish(id, provider)).toBe("completed");
    const { groups } = await analysisFindings(db, id);
    const all = groups.flatMap((g) => g.findings);
    expect(all).toHaveLength(2);
    const merged = all.find((x) => x.direct?.duplicates === 1)!;
    expect(merged.group).toBe("needs_context"); // the cautious copy is the one shown
    expect((await findingDetail(db, merged.id))!.direct!.duplicates).toHaveLength(1);
  });

  it("carries a person's decision into a later report of the same passages", async () => {
    const f = await realFinding();
    const one = await create();
    await finish(one, mockProvider([success(output([f]))]).provider);
    await db.update(findings).set({ reviewState: "dismissed", reviewNote: "Not material", reviewedAt: new Date() });
    const two = await create();
    await finish(two, mockProvider([success(output([f]))]).provider);
    const [row] = (await analysisFindings(db, two)).groups.flatMap((g) => g.findings);
    expect([row.reviewState, row.reviewNote]).toEqual(["dismissed", "Not material"]);
    expect((await analysisView(db, two))!.findings.decided).toBe(1);
  });

  it("gives the same evidence key in a later analysis, so a review can carry over", async () => {
    const f = await realFinding();
    const keyOf = async (id: number) => (await analysisFindings(db, id)).groups.flatMap((g) => g.findings)[0].direct!.evidenceKey;
    const one = await create();
    await finish(one, mockProvider([success(output([f]))]).provider);
    const two = await create();
    await finish(two, mockProvider([success(output([f]))]).provider);
    expect(await keyOf(two)).toBe(await keyOf(one));
  });
});
