// Adjudication end to end against the test database, with a fake adjudicator: no API call is made.
// See tests/db/database.ts for when these run.

import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adjudicateCandidate, formatPacket, loadPacket, persistCandidates, type Adjudicator, type Verdict } from "../../server/src/adjudicate";
import { BudgetExceeded, budgetStatus, ensureBudget } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { budgetReservations, candidates, cases, exchanges, findings, llmCalls, orgs, verdicts, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION, saveDeposition } from "../../server/src/ingest";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import type { SourceLine } from "../../server/src/ingest/pdf";
import type { Candidate } from "../../server/src/retrieve";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const TURN = 112.5;
const src = (page: number, lineNo: number, rawText: string): SourceLine => ({ pdfPage: 1, printedPage: page, lineNo, lineFromPosition: lineNo, indentX: TURN, rawText });

const usage = { input_tokens: 2000, output_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null } as unknown as Anthropic.Usage;

function fakeAdjudicator(reply: (packetText: string) => { stopReason?: string; text: string | null } | Error): Adjudicator & { calls: string[] } {
  const calls: string[] = [];
  return {
    model: "claude-sonnet-5-5",
    effort: "medium",
    promptVersion: "adjudicate-v1",
    calls,
    async adjudicate(packetText) {
      calls.push(packetText);
      const r = reply(packetText);
      if (r instanceof Error) throw r;
      return { model: "claude-sonnet-5-5", stopReason: r.stopReason ?? "end_turn", usage, text: r.text, latencyMs: 1234 };
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("adjudication (Postgres, fake adjudicator)", () => {
  let pool: Pool;
  let db: Database;
  let candidateId: number;
  let ids: { a: string; b: string };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool?.end();
  });

  const deposition = async (caseId: number, witnessId: number, sha: string, rows: SourceLine[]) => {
    const read = {
      parserVersion: PARSER_VERSION,
      pdf: null,
      validation: { status: "ready", layout: LAYOUT.name, pageCount: 1, counts: { text: 1, blank: 0, needs_ocr: 0, failed: 0 }, needsOcrPages: [], blankPages: [], failedPages: [], reasons: [], pages: [] } as never,
      exchanges: buildExchangeParts(rows, LAYOUT),
    };
    return (await saveDeposition(db, { caseId, witnessId, takenOn: null, fileSha256: sha, storageKey: `${sha}.pdf`, read })).depositionId;
  };

  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
    const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
    const d1 = await deposition(kase.id, witness.id, "a".repeat(64), [
      src(10, 1, "Q. Where were you that morning?"),
      src(10, 2, "A. At home."),
      src(10, 3, "Q. Did you approve the Hartley contract?"),
      src(10, 4, "A. Yes."),
      src(10, 5, "Q. When?"),
      src(10, 6, "A. In March."),
    ]);
    const d2 = await deposition(kase.id, witness.id, "b".repeat(64), [
      src(20, 1, "Q. Let's turn to Hartley."),
      src(20, 2, "A. Okay."),
      src(20, 3, "Q. Who approved the Hartley contract?"),
      src(20, 4, "A. I never approved the Hartley contract."),
      src(20, 5, "Q. Thank you."),
      src(20, 6, "A. Sure."),
    ]);
    const part = async (depositionId: number, text: string) => {
      const rows = await db.select().from(exchanges).where(eq(exchanges.depositionId, depositionId));
      return rows.find((r) => r.questionText.includes(text))!;
    };
    const a = await part(d1, "approve the Hartley");
    const b = await part(d2, "approved the Hartley");
    const candidate: Candidate = {
      rank: 1,
      rrfScore: 1 / 61,
      a: { depositionId: d1, groupId: a.groupId },
      b: { depositionId: d2, groupId: b.groupId },
      sources: ["fulltext"],
      ranks: { fulltext: 1 },
      evidence: [{ path: "fulltext", rank: 1, exchangeA: a.id, exchangeB: b.id, score: 3, sharedTerms: ["hartley"] }],
    };
    await persistCandidates(db, { set: "test-set", witnessId: witness.id, selected: [candidate], deferred: [] });
    [{ id: candidateId }] = await db.select({ id: candidates.id }).from(candidates);
    ids = { a: `E${a.id}`, b: `E${b.id}` };
  });

  const verdict = (fields: Partial<Verdict> = {}): Verdict => ({
    classification: "direct",
    evidenceAId: ids.a,
    evidenceBId: ids.b,
    keyPhraseA: "Did you approve the Hartley contract",
    keyPhraseB: "I never approved the Hartley contract",
    attributionA: "asserted",
    attributionB: "asserted",
    stanceA: "affirms",
    stanceB: "affirms",
    sameEvent: "yes",
    scopeAligned: "yes",
    conflictBasis: "explicit_negation",
    aboutTimingOfSameEvent: false,
    inferenceSteps: [],
    unestablishedAssumptions: [],
    falsePositiveReason: null,
    explanation: "10:03-04 against 20:04.",
    alternativeExplanation: null,
    needsMoreContext: false,
    ...fields,
  });

  it("builds the packet from stored lines, with context and no retrieval signals", async () => {
    const packet = await loadPacket(db, candidateId);
    const text = formatPacket(packet);
    expect(packet.a.id).toBe(ids.a);
    expect(packet.a.lines.map((l) => l.text)).toEqual(["Q. Did you approve the Hartley contract?", "A. Yes."]);
    expect(packet.a.before.map((l) => `${l.page}:${l.line}`)).toEqual(["10:1", "10:2"]);
    expect(packet.a.after.map((l) => `${l.page}:${l.line}`)).toEqual(["10:5", "10:6"]);
    expect(text).toContain("10:03  Q. Did you approve the Hartley contract?");
    expect(text).not.toMatch(/hartley"\]|rank|score|fulltext/i);
  });

  it("stores the verdict, the scored finding, the call with effort and latency, and settles the budget", async () => {
    const budgetId = await ensureBudget(db, "adj", 1);
    const result = await adjudicateCandidate(db, candidateId, fakeAdjudicator(() => ({ text: JSON.stringify(verdict()) })), { budgetId });
    expect(result.status).toBe("valid");
    const [f] = await db.select().from(findings);
    expect(f).toMatchObject({ type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", rubricVersion: "v1", priority: "high" });
    expect(f.score).toBeGreaterThanOrEqual(75);
    const [v] = await db.select().from(verdicts);
    expect(v).toMatchObject({ status: "valid", promptVersion: "adjudicate-v1", effort: "medium", model: "claude-sonnet-5-5" });
    expect((v.packet as { sides: { lineIds: number[] }[] }).sides[0].lineIds).toHaveLength(2);
    const [call] = await db.select().from(llmCalls);
    expect(call).toMatchObject({ stage: "adjudication", effort: "medium", latencyMs: 1234, items: 1 });
    const [r] = await db.select().from(budgetReservations);
    expect(r).toMatchObject({ status: "settled", llmCallId: call.id, actualUsd: call.costUsd });
    expect((await budgetStatus(db, budgetId)).spentUsd).toBeCloseTo(call.costUsd!, 8);
    expect((await db.select().from(candidates))[0].status).toBe("adjudicated");
  });

  it("keeps a wrong reference as an unscored finding, never a verified one", async () => {
    const budgetId = await ensureBudget(db, "adj", 1);
    await adjudicateCandidate(db, candidateId, fakeAdjudicator(() => ({ text: JSON.stringify(verdict({ evidenceAId: ids.b })) })), { budgetId });
    const [f] = await db.select().from(findings);
    expect(f).toMatchObject({ evidenceStatus: "wrong_reference", score: null, band: null, unscoredReason: "evidence", priority: "low" });
  });

  it("stores an invalid, refused or cut-off response as received, with its billed call and no finding", async () => {
    const budgetId = await ensureBudget(db, "adj", 1);
    const replies = [
      { text: JSON.stringify({ ...verdict(), confidence: 0.9 }), status: "schema_invalid" },
      { text: "not json", status: "schema_invalid" },
      { stopReason: "refusal", text: null, status: "refused" },
      { stopReason: "max_tokens", text: '{"classification": "dir', status: "cut_off" },
    ];
    for (const r of replies) {
      const result = await adjudicateCandidate(db, candidateId, fakeAdjudicator(() => r), { budgetId, allowRepeat: true });
      expect(result.status).toBe(r.status);
      expect(result.findingId).toBeNull();
    }
    expect(await db.select().from(findings)).toHaveLength(0);
    expect(await db.select().from(llmCalls)).toHaveLength(4);
    expect((await db.select().from(verdicts)).map((v) => v.raw)).toEqual(replies.map((r) => r.text));
    expect((await db.select().from(candidates))[0].status).toBe("selected");
  });

  it("stops before calling when the budget can't cover the worst case", async () => {
    const budgetId = await ensureBudget(db, "tiny", 0.01);
    const model = fakeAdjudicator(() => ({ text: JSON.stringify(verdict()) }));
    await expect(adjudicateCandidate(db, candidateId, model, { budgetId })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(model.calls).toHaveLength(0);
    expect(await db.select().from(verdicts)).toHaveLength(0);
  });

  it("counts a call that may have been billed at its full reservation, and stores no verdict", async () => {
    const budgetId = await ensureBudget(db, "adj", 1);
    await expect(adjudicateCandidate(db, candidateId, fakeAdjudicator(() => new Error("socket hang up")), { budgetId })).rejects.toThrow("socket hang up");
    const [r] = await db.select().from(budgetReservations);
    expect(r.status).toBe("uncertain");
    expect((await budgetStatus(db, budgetId)).spentUsd).toBe(r.maxUsd);
    expect(await db.select().from(verdicts)).toHaveLength(0);
  });

  it("refuses to adjudicate a candidate twice unless asked", async () => {
    const budgetId = await ensureBudget(db, "adj", 1);
    const model = fakeAdjudicator(() => ({ text: JSON.stringify(verdict()) }));
    await adjudicateCandidate(db, candidateId, model, { budgetId });
    await expect(adjudicateCandidate(db, candidateId, model, { budgetId })).rejects.toThrow("already has adjudicate-v1 verdict");
    expect(model.calls).toHaveLength(1);
  });

  it("refuses to overwrite a candidate set", async () => {
    await expect(persistCandidates(db, { set: "test-set", witnessId: 1, selected: [], deferred: [] })).rejects.toThrow("already exists");
  });
});
