// scripts/direct-model.ts's paid path, end to end with a mock provider and no paid call: the gate, the
// cap, what is sent, what is recorded and that the analysis itself is never touched.
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveryProvider, DiscoveryRequest, DiscoveryResult } from "../../server/src/adjudicate";
import { paidRunCap, reportProposals, runComparison, storedComparison } from "../../server/src/adjudicate/compareModels";
import { withDistractors } from "../../server/src/eval";
import { WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import type { Database } from "../../server/src/db/client";
import { analyses, budgetReservations, budgets, candidates, depositions, discoveryRuns, findings, lines, llmCalls } from "../../server/src/db/schema";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe("paidRunCap (pure)", () => {
  const env = { ANTHROPIC_API_KEY: "k", ALLOW_PAID_CALLS: "true" };
  it("returns the approved cap only with a key, ALLOW_PAID_CALLS=true, --execute and a positive cap", () => {
    expect(paidRunCap(env, true, "1.70")).toBe(1.7);
    expect(() => paidRunCap({}, true, "1")).toThrow(/Paid calls are off/);
    expect(() => paidRunCap({ ANTHROPIC_API_KEY: "k", ALLOW_PAID_CALLS: "false" }, true, "1")).toThrow(/Paid calls are off/);
    expect(() => paidRunCap({ ALLOW_PAID_CALLS: "true" }, true, "1")).toThrow(/Paid calls are off/);
    expect(() => paidRunCap(env, false, "1")).toThrow(/--execute/);
    for (const cap of [undefined, "0", "-1", "abc"]) expect(() => paidRunCap(env, true, cap)).toThrow(/--approved-usd/);
  });
});

const USAGE = { input_tokens: 9000, output_tokens: 3000, output_tokens_details: { thinking_tokens: 2000 } };
const answer = (findingsList: unknown[], status = "complete") => JSON.stringify({ summary: { completion_status: status, limitations: status === "complete" ? [] : ["ran out of room"] }, findings: findingsList });
const message = (text: string, stop = "end_turn"): DiscoveryResult => ({ type: "succeeded", message: { model: "claude-opus-5-5", stop_reason: stop, content: [{ type: "text", text }], usage: USAGE } as never });

function mockProvider(result: DiscoveryResult) {
  const sent: DiscoveryRequest[] = [];
  let polls = 0;
  const provider: DiscoveryProvider = {
    submit: async (r) => (sent.push(r), { batchId: "batch-1" }),
    poll: async () => ({ ended: ++polls >= 2, latencyMs: 1000 }),
    result: async () => result,
    cancel: async () => undefined,
  };
  return { provider, sent };
}

describe.skipIf(!TEST_DATABASE_URL)("runComparison (Postgres, mock provider)", () => {
  let db: Database;
  let pool: Pool;
  let analysisId: number;
  let depositionIds: number[];

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    ({ depositionIds } = await storeSessions(db, withDistractors(WHITFIELD_SUITE, 5)));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, depositionIds[0]));
    const [a] = await db.insert(analyses).values({ caseId: d.caseId, witnessId: d.witnessId, depositionA: depositionIds[0], depositionB: depositionIds[1], mode: "live", retrieval: "direct_fable", promptVersion: "discover-v1", effort: "xhigh", maxCandidates: 1, budgetUsd: 6 }).returning();
    analysisId = a.id;
  });

  async function realFinding() {
    const witnessLine = async (id: number) => (await db.select().from(lines).where(eq(lines.depositionId, id))).sort((x, y) => x.printedPage - y.printedPage || x.lineNo - y.lineNo).find((l) => l.speakerRole === "witness" && l.rawText.replace(/^A\.\s*/, "").length > 10)!;
    const [x, y] = [await witnessLine(depositionIds[0]), await witnessLine(depositionIds[1])];
    const ref = (l: typeof x) => `${l.printedPage}:${String(l.lineNo).padStart(2, "0")}`;
    return { finding_id: "F1", witness: WHITFIELD_SUITE.witness, session_a: "A", citation_a: ref(x), exact_excerpt_a: x.rawText.replace(/^A\.\s*/, ""), session_b: "B", citation_b: ref(y), exact_excerpt_b: y.rawText.replace(/^A\.\s*/, ""), shared_subject: "s", comparable: "yes", classification: "direct_contradiction", factual_proposition_a: "pa", factual_proposition_b: "pb", conflict_basis: "c", explanation: "e", alternative_explanation: "alt", missing_context: "", confidence_rationale: "r" };
  }
  const untouched = async () => {
    expect(await db.select().from(candidates)).toEqual([]);
    expect(await db.select().from(findings)).toEqual([]);
    expect(await db.select().from(discoveryRuns)).toEqual([]);
    const [a] = await db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe("queued");
  };

  it("sends the live request to the chosen model, verifies its findings, records the cost, and leaves the analysis alone", async () => {
    const { provider, sent } = mockProvider(message(answer([await realFinding()])));
    const report = await runComparison(db, { analysisId, model: "opus", capUsd: 2, provider, pollMs: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "claude-opus-5-5", maxOutputTokens: 64_000 });
    expect(report).toMatchObject({ status: "succeeded", completion: "complete", source: "paid run" });
    expect(report.findings).toHaveLength(1);
    expect(report.findings![0]).toMatchObject({ lane: "contradictions", evidenceStatus: "verified" });
    expect(report.sessions.map((s) => s.sha256)).toEqual(expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/)]));
    const [call] = await db.select().from(llmCalls);
    expect(call).toMatchObject({ model: "claude-opus-5-5", stage: "discovery", batch: true });
    expect(report.costUsd).toBeCloseTo(call.costUsd!, 8);
    const [reservation] = await db.select().from(budgetReservations);
    expect(reservation.status).toBe("settled");
    await untouched();
  });

  it("sends nothing when the worst case is over the cap", async () => {
    const { provider, sent } = mockProvider(message(answer([])));
    await expect(runComparison(db, { analysisId, model: "fable", capUsd: 0.01, provider, pollMs: 0 })).rejects.toThrow(/Not sent: the worst case/);
    expect(sent).toEqual([]);
    expect(await db.select().from(llmCalls)).toEqual([]);
  });

  it("records a cut-off answer's cost but gives it no findings", async () => {
    const { provider } = mockProvider(message('{"summary":', "max_tokens"));
    const report = await runComparison(db, { analysisId, model: "opus", capUsd: 2, provider, pollMs: 0 });
    expect(report).toMatchObject({ status: "incomplete" });
    expect(report.findings).toBeUndefined();
    expect(report.error).toMatch(/max_tokens/);
    expect(await db.select().from(llmCalls)).toHaveLength(1);
  });

  it("releases the reservation of an expired batch, which nobody is billed for", async () => {
    const { provider } = mockProvider({ type: "expired" });
    const report = await runComparison(db, { analysisId, model: "opus", capUsd: 2, provider, pollMs: 0 });
    expect(report.error).toBe("batch result: expired");
    const [reservation] = await db.select().from(budgetReservations);
    expect(reservation.status).toBe("released");
    const [b] = await db.select().from(budgets);
    expect(b.spentUsd).toBe(0);
  });

  it("re-checks a stored answer with no call, and maps its sessions to label documents by file hash", async () => {
    const { provider } = mockProvider(message(answer([await realFinding()])));
    const run = await runComparison(db, { analysisId, model: "opus", capUsd: 2, provider, pollMs: 0 });
    // Store that answer as the analysis's own, as a finished live run would.
    const [call] = await db.select().from(llmCalls);
    await db.insert(discoveryRuns).values({ analysisId, attempt: 1, role: "primary", model: "claude-opus-5-5", promptVersion: "discover-v1", effort: "xhigh", maxOutputTokens: 64000, status: "succeeded", customId: "c", maxCostUsd: 1, llmCallId: call.id, sourceHashes: {} });
    const stored = await storedComparison(db, analysisId);
    expect(stored.findings).toEqual(run.findings);
    expect(await db.select().from(llmCalls)).toHaveLength(1); // no new call

    const [a, b] = run.sessions;
    const proposals = reportProposals(run, { june: { sha256: a.sha256! }, sept: { sha256: b.sha256! } });
    expect(proposals).toEqual([{ a: { document: "june", citation: run.findings![0].a.citation }, b: { document: "sept", citation: run.findings![0].b.citation }, modelClassification: "direct_contradiction" }]);
    expect(reportProposals(run, { other: { sha256: "f".repeat(64) } })).toEqual([]); // another file is never credited
  });
});
