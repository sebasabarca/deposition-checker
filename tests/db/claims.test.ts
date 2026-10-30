// Claim tagging end to end against the test database, with a fake model: no API call is made.
// See tests/db/database.ts for when these run.

import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION, reverifyClaims, tagClaims, type ClaimModel, type ExtractedClaim } from "../../server/src/claims";
import type { Database } from "../../server/src/db/client";
import { BudgetExceeded, budgetStatus, ensureBudget } from "../../server/src/costs";
import { budgetReservations, cases, claims, claimTagging, depositions, exchanges, llmCalls, orgs, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION, saveDeposition } from "../../server/src/ingest";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import type { SourceLine } from "../../server/src/ingest/pdf";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const TURN = 112.5;
const src = (lineNo: number, rawText: string): SourceLine => ({ pdfPage: 1, printedPage: 161, lineNo, lineFromPosition: lineNo, indentX: TURN, rawText });

const usage = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  output_tokens_details: { thinking_tokens: 150 },
} as unknown as Anthropic.Usage;

// A model that answers from a script, and remembers what it was asked.
function fakeModel(reply: (batchText: string, call: number) => { stopReason?: string; text?: string | null } | Error): ClaimModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    model: "claude-haiku-5-5",
    calls,
    async extract(batchText) {
      calls.push(batchText);
      const r = reply(batchText, calls.length);
      if (r instanceof Error) throw r;
      return { stopReason: r.stopReason ?? "end_turn", usage, text: r.text === undefined ? null : r.text };
    },
  };
}

const claim = (fields: Partial<ExtractedClaim>): ExtractedClaim => ({
  exchangeId: "",
  source: "answer",
  keyPhrase: "",
  answerPhrase: null,
  subject: "Oracle",
  predicate: "buy",
  object: null,
  polarity: "affirms",
  epistemic: "asserted",
  time: null,
  place: null,
  quantity: null,
  entities: [],
  dependsOnEarlierExchange: false,
  ...fields,
});

describe.skipIf(!TEST_DATABASE_URL)("claim tagging (Postgres, fake model)", () => {
  let pool: Pool;
  let db: Database;
  let depositionId: number;
  let parts: number[];

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
    const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
    const read = {
      parserVersion: PARSER_VERSION,
      pdf: null,
      validation: { status: "ready", layout: LAYOUT.name, pageCount: 1, counts: { text: 1, blank: 0, needs_ocr: 0, failed: 0 }, needsOcrPages: [], blankPages: [], failedPages: [], reasons: [], pages: [] } as never,
      exchanges: buildExchangeParts(
        [
          src(1, "Q. Did Oracle buy PeopleSoft software?"),
          src(2, "A. Yes, we did."),
          src(3, "Q. Who approved the discount?"),
          src(4, "A. Safra Catz approved the discount in May."),
          src(5, "Q. Did you meet with SAP?"),
          src(6, "A. I don't recall meeting SAP."),
        ],
        LAYOUT,
      ),
    };
    const saved = await saveDeposition(db, { caseId: kase.id, witnessId: witness.id, takenOn: null, fileSha256: "a".repeat(64), storageKey: "a.pdf", read });
    depositionId = saved.depositionId;
    parts = (await db.select({ id: exchanges.id }).from(exchanges).orderBy(exchanges.id)).map((r) => r.id);
  });

  const json = (cs: ExtractedClaim[]) => JSON.stringify({ claims: cs });

  it("stores every claim with code's verdict, marks the parts tagged, and records the call", async () => {
    const model = fakeModel(() => ({
      text: json([
        claim({ exchangeId: `E${parts[0]}`, source: "adopted_question", keyPhrase: "Did Oracle buy PeopleSoft software", answerPhrase: "Yes, we did", entities: ["Oracle", "PeopleSoft"] }),
        claim({ exchangeId: `E${parts[1]}`, keyPhrase: "Safra Catz approved the discount", predicate: "approve", subject: "Safra Catz", time: "May", entities: ["Ms. Safra Catz", "Oracle"] }),
        claim({ exchangeId: `E${parts[1]}`, keyPhrase: "IBM approved it" }), // not in the testimony
        claim({ exchangeId: "E999999", keyPhrase: "anything" }), // not in the batch
      ]),
    }));
    const result = await tagClaims(db, depositionId, model);

    expect(result.parts).toEqual({ attempted: 3, tagged: 3, failed: 0, refused: 0, skipped: 0 });
    expect(result.claims).toEqual({ verified: 2, approximate: 0, rejected: 2, rejectionReasons: { phrase_not_in_testimony: 1, unknown_exchange: 1 } });

    const stored = await db.select().from(claims).orderBy(claims.id);
    expect(stored.map((c) => [c.citedExchange, c.status, c.rejectionReason])).toEqual([
      [`E${parts[0]}`, "verified", null],
      [`E${parts[1]}`, "verified", null],
      [`E${parts[1]}`, "rejected", "phrase_not_in_testimony"],
      ["E999999", "rejected", "unknown_exchange"],
    ]);
    expect(stored[0]).toMatchObject({ exchangeId: parts[0], source: "adopted_question", answerPhrase: "Yes, we did", entities: ["oracle", "peoplesoft"], extractorVersion: EXTRACTOR_VERSION });
    expect(stored[0].evidenceLineIds).toHaveLength(2); // the question line and the answer line
    expect(stored[3].exchangeId).toBeNull();
    expect(stored[1]).toMatchObject({ entities: ["safra catz"], ungroundedEntities: ["oracle"], dependsOnEarlier: false, contextDependent: false });

    const tagging = await db.select().from(claimTagging).orderBy(claimTagging.exchangeId);
    expect(tagging.map((t) => [t.status, t.claims])).toEqual([["tagged", 1], ["tagged", 2], ["tagged", 0]]);
    const [call] = await db.select().from(llmCalls);
    expect(call).toMatchObject({ stage: "claim_tagging", model: "claude-haiku-5-5", items: 3, inputTokens: 1000, outputTokens: 200, thinkingTokens: 150 });
    expect(JSON.parse(call.rawOutput!).claims).toHaveLength(4); // the response kept as received
    expect(stored.every((c) => c.llmCallId === call.id)).toBe(true);
  });

  it("records a refused batch as refused, with its billed call, and a cut-off or invalid one as failed", async () => {
    // Each case on fresh tagging state of the same deposition.
    for (const [reply, status, error] of [
      [{ stopReason: "refusal" }, "refused", /declined/],
      [{ stopReason: "max_tokens", text: "{" }, "failed", /cut off/],
      [{ text: '{"claims":[{"confidence":0.9}]}' }, "failed", /invalid output/],
    ] as const) {
      await db.delete(claimTagging);
      await db.delete(llmCalls);
      const result = await tagClaims(db, depositionId, fakeModel(() => reply));
      expect(result.parts[status]).toBe(3);
      const rows = await db.select().from(claimTagging);
      expect(rows.every((r) => r.status === status && error.test(r.error ?? "") && r.llmCallId !== null)).toBe(true);
      expect(await db.$count(llmCalls)).toBe(1);
      expect(await db.$count(claims)).toBe(0);
    }
  });

  it("records a call that never answered as failed, with no call row", async () => {
    const result = await tagClaims(db, depositionId, fakeModel(() => new Error("connection reset")));
    expect(result.parts.failed).toBe(3);
    const rows = await db.select().from(claimTagging);
    expect(rows.map((r) => [r.status, r.error, r.llmCallId])).toEqual(Array(3).fill(["failed", "call failed: connection reset", null]));
    expect(await db.$count(llmCalls)).toBe(0);
  });

  it("re-runs only what isn't tagged, and never duplicates claims", async () => {
    // One answer claim per part of the batch it is given.
    const good = (batchText: string) => ({
      text: json([...batchText.matchAll(/\[(E\d+)\]/g)].map(([, label]) => claim({ exchangeId: label, keyPhrase: "Yes" }))),
    });
    // Pilot: one batch of two parts, then the second batch fails.
    await tagClaims(db, depositionId, fakeModel(good), { batchSize: 2, maxBatches: 1 });
    await tagClaims(db, depositionId, fakeModel(() => new Error("timeout")), { batchSize: 2 });
    expect((await db.select().from(claimTagging).orderBy(claimTagging.exchangeId)).map((r) => r.status)).toEqual(["tagged", "tagged", "failed"]);

    const retry = fakeModel(good);
    const result = await tagClaims(db, depositionId, retry, { batchSize: 2 });
    expect(retry.calls).toHaveLength(1); // only the failed part
    expect(retry.calls[0]).toContain(`[E${parts[2]}]`);
    expect(result.parts).toMatchObject({ attempted: 1, tagged: 1, skipped: 2 });

    const again = fakeModel(good);
    await tagClaims(db, depositionId, again);
    expect(again.calls).toHaveLength(0); // everything tagged for this extractor version
    // One claim per part: the failed attempt left none, and the retry didn't add a second.
    const stored = await db.select({ exchangeId: claims.exchangeId }).from(claims);
    expect(stored.map((c) => c.exchangeId).sort()).toEqual([...parts].sort());
  });

  it("re-applies code's checks to stored claims without calling the model", async () => {
    await tagClaims(
      db,
      depositionId,
      fakeModel(() => ({ text: json([claim({ exchangeId: `E${parts[1]}`, keyPhrase: "Safra Catz approved the discount", entities: ["Safra Catz", "Oracle"] })]) })),
    );
    // Simulate a claim stored before entity grounding existed.
    await db.update(claims).set({ entities: ["oracle", "safra catz"], ungroundedEntities: [] });
    const result = await reverifyClaims(db, depositionId);
    expect(result).toEqual({ claims: 1, changed: { status: 0, hedge: 0, contextDependent: 0, entities: 1 } });
    expect((await db.select().from(claims))[0]).toMatchObject({ entities: ["safra catz"], ungroundedEntities: ["oracle"] });
  });

  it("tags only the chosen parts when given a sample", async () => {
    const model = fakeModel(() => ({ text: json([]) }));
    const result = await tagClaims(db, depositionId, model, { only: [parts[2], parts[0]] });
    expect(result.parts.attempted).toBe(2);
    expect(model.calls[0]).toContain(`[E${parts[0]}]`);
    expect(model.calls[0]).not.toContain(`[E${parts[1]}]`);
    expect((await db.select().from(claimTagging)).map((r) => r.exchangeId).sort()).toEqual([parts[0], parts[2]].sort());
  });

  it("refuses to tag a deposition that isn't ready", async () => {
    await db.update(depositions).set({ status: "processing", validation: null, pageCount: null }).where(eq(depositions.id, depositionId));
    await expect(tagClaims(db, depositionId, fakeModel(() => ({ text: json([]) })))).rejects.toThrow("only ready depositions are tagged");
  });

  it("with a budget, reserves each batch before calling and settles it at the recorded cost", async () => {
    const budgetId = await ensureBudget(db, "patha-test", 1);
    const result = await tagClaims(db, depositionId, fakeModel(() => ({ text: json([]) })), { batchSize: 2, budgetId });
    const reservations = await db.select().from(budgetReservations).orderBy(budgetReservations.id);
    const calls = await db.select().from(llmCalls).orderBy(llmCalls.id);
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.status === "settled")).toBe(true);
    expect(reservations.map((r) => r.llmCallId)).toEqual(result.llmCallIds);
    expect(reservations.map((r) => r.actualUsd)).toEqual(calls.map((c) => c.costUsd));
    for (const r of reservations) expect(r.maxUsd).toBeGreaterThan(r.actualUsd!);
    const b = await budgetStatus(db, budgetId);
    expect(b.reservedUsd).toBe(0);
    expect(b.spentUsd).toBeCloseTo(calls.reduce((t, c) => t + c.costUsd!, 0), 8);
  });

  it("stops before calling when the budget can't cover a batch's worst case, leaving the parts untagged", async () => {
    const budgetId = await ensureBudget(db, "tiny", 0.0001);
    const model = fakeModel(() => ({ text: json([]) }));
    await expect(tagClaims(db, depositionId, model, { budgetId })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(model.calls).toHaveLength(0);
    expect(await db.select().from(claimTagging)).toHaveLength(0);
    expect((await budgetStatus(db, budgetId)).spentUsd).toBe(0);
  });

  it("counts a batch whose call may have been billed at its full reservation", async () => {
    const budgetId = await ensureBudget(db, "patha-test", 1);
    await tagClaims(db, depositionId, fakeModel(() => new Error("socket hang up")), { budgetId });
    const [r] = await db.select().from(budgetReservations);
    expect(r.status).toBe("uncertain");
    expect((await budgetStatus(db, budgetId)).spentUsd).toBe(r.maxUsd);
  });
});