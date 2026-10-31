// Statement-card extraction and the topic map against Postgres, with mock models. No API call.
// See tests/db/database.ts for when these run.

import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTopicMap, cardSummary, CARD_EXTRACTOR_VERSION, CARD_MAX_OUTPUT_TOKENS, extractCards, latestMapVersion, mapMembers, plannedChunks, screenStoredNoAssertions, type ClaimModel } from "../../server/src/claims";
import { budgetStatus, ensureBudget, maxRequestCost } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { cardCoverage, cardTopics, llmCalls, statementCards, topics } from "../../server/src/db/schema";
import { mockCardModel, mockTopicModel, withDistractors } from "../../server/src/eval";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const coverageOf = async (db: Database, depositionId: number) => (await cardSummary(db, depositionId)).coverage;

describe.skipIf(!TEST_DATABASE_URL)("statement cards and topics (Postgres)", () => {
  let db: Database;
  let pool: Pool;
  let witnessId: number;
  let depositionIds: number[];

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    ({ witnessId, depositionIds } = await storeSessions(db, withDistractors(WEBB_SUITE, 240)));
  });

  it("gives every eligible part a status, and records every call", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel());
    expect(r.chunks.planned).toBeGreaterThan(1);
    expect(r.coverage.not_processed + r.coverage.failed + r.coverage.omitted).toBe(0);
    expect(r.cards.duplicates).toBeGreaterThan(0); // the overlap page
    expect(r.cards.rejected).toBe(0);
    const rows = await db.select().from(cardCoverage).where(eq(cardCoverage.depositionId, depositionIds[0]));
    expect(rows.filter((c) => c.status === "carded").every((c) => c.cards >= 1)).toBe(true);
    const calls = await db.select().from(llmCalls);
    expect(calls).toHaveLength(r.chunks.sent);
    expect(calls.every((c) => c.stage === "statement_cards" && c.costUsd !== null)).toBe(true);
  });

  it("every usable card keeps exact source lines inside its exchange", async () => {
    await extractCards(db, depositionIds[0], mockCardModel());
    const cards = await db.select().from(statementCards).where(eq(statementCards.status, "usable"));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.firstLineId !== null && c.lastLineId !== null && c.firstLineId <= c.lastLineId!)).toBe(true);
  });

  it("a re-run calls nothing and adds nothing", async () => {
    await extractCards(db, depositionIds[0], mockCardModel());
    const before = await db.$count(statementCards);
    const again = mockCardModel();
    const r = await extractCards(db, depositionIds[0], again);
    expect(again.calls).toBe(0);
    expect(r.chunks.planned).toBe(0);
    expect(await db.$count(statementCards)).toBe(before);
  });

  it("measures rejections and keeps every rejected card with its reason", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel({ fabricateEvery: 5, unknownExchangeEvery: 7 }));
    expect(r.rejectionReasons.source_phrase_not_in_exchange).toBeGreaterThan(0);
    expect(r.rejectionReasons.unknown_exchange).toBeGreaterThan(0);
    const summary = await cardSummary(db, depositionIds[0]);
    expect(summary.cards.sourceGroundingRate).toBeGreaterThan(0.5);
    expect(summary.cards.sourceGroundingRate).toBeLessThan(1);
    const rejected = await db.select().from(statementCards).where(eq(statementCards.status, "rejected"));
    expect(rejected.every((c) => c.rejectionReason !== null && c.raw !== null)).toBe(true);
  });

  it("a part the model never mentions is omitted, and the next run retries only what's left", async () => {
    const first = await extractCards(db, depositionIds[0], mockCardModel({ omitEvery: 4 }));
    expect(first.coverage.omitted).toBeGreaterThan(0);
    const second = await extractCards(db, depositionIds[0], mockCardModel());
    expect(second.coverage.omitted).toBe(0);
    expect(second.chunks.sent).toBeLessThanOrEqual(first.chunks.sent);
  });

  it("flags a call that ended normally but skipped most of its chunk", async () => {
    const thin = await extractCards(db, depositionIds[0], mockCardModel({ omitEvery: 1 }), { maxChunks: 1 });
    expect(thin.thinChunks).toHaveLength(1);
    expect(thin.thinChunks[0]).toMatchObject({ addressed: 0 });
    expect(thin.thinChunks[0].parts).toBeGreaterThan(0);
    expect((await extractCards(db, depositionIds[0], mockCardModel(), { maxChunks: 1 })).thinChunks).toEqual([]);
  });

  describe("suspected omissions", () => {
    const silent = (sent: string[] = []): ClaimModel => ({ model: "claude-haiku-5-5", extract: async (text) => (sent.push(text), { stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } as never, text: JSON.stringify({ cards: [], noAssertion: [...text.matchAll(/^\[(E\d+)\]$/gm)].map((m) => m[1]) }) }) });
    const suspects = () => db.select().from(cardCoverage).where(eq(cardCoverage.status, "suspected_omission"));

    it("flags them with their signals and the response, and a normal re-run doesn't pay for them again", async () => {
      await extractCards(db, depositionIds[0], silent(), { maxChunks: 1 });
      const flagged = await suspects();
      expect(flagged.length).toBeGreaterThan(0);
      expect(flagged.every((c) => c.suspicionSignals.length > 0 && c.suspectedCallId !== null)).toBe(true);
      const again = mockCardModel();
      await extractCards(db, depositionIds[0], again);
      const flaggedIds = new Set(flagged.map((c) => c.exchangeId));
      expect((await suspects()).every((c) => flaggedIds.has(c.exchangeId))).toBe(true);
      expect((await suspects()).length).toBe(flagged.length);
    });

    it("targeted extraction sends each with context, recovers cards, and keeps the record of the first response", async () => {
      await extractCards(db, depositionIds[0], silent(), { maxChunks: 1 });
      const [first] = await suspects();
      const sent: string[] = [];
      const real = mockCardModel();
      const r = await extractCards(db, depositionIds[0], { model: real.model, extract: (text) => (sent.push(text), real.extract(text)) }, { targeted: true, only: [first.exchangeId] });
      expect(sent).toHaveLength(1);
      expect([...sent[0].matchAll(/^\[(E\d+)\]$/gm)].map((m) => m[1])).toEqual([`E${first.exchangeId}`]);
      expect(r.cards.usable).toBeGreaterThan(0);
      const [row] = await db.select().from(cardCoverage).where(eq(cardCoverage.exchangeId, first.exchangeId));
      expect(row).toMatchObject({ status: "carded", suspectedCallId: first.suspectedCallId, suspicionSignals: first.suspicionSignals });
      expect(row.llmCallId).not.toBe(first.suspectedCallId);
    });

    it("a repeated noAssertion stays suspected, never confirmed by repetition", async () => {
      await extractCards(db, depositionIds[0], silent(), { maxChunks: 1 });
      const before = (await suspects()).length;
      await extractCards(db, depositionIds[0], silent(), { targeted: true });
      expect((await suspects()).length).toBe(before);
    });

    it("targeted extraction leaves accepted cards alone", async () => {
      await extractCards(db, depositionIds[0], mockCardModel());
      const before = await db.$count(statementCards);
      const r = await extractCards(db, depositionIds[0], mockCardModel(), { targeted: true });
      expect(r.chunks.planned).toBe(0);
      expect(await db.$count(statementCards)).toBe(before);
    });

    it("screens stored results without a call, and repeating changes nothing", async () => {
      await extractCards(db, depositionIds[0], silent(), { maxChunks: 1 });
      await db.update(cardCoverage).set({ status: "no_assertion", suspicionSignals: [], suspectedCallId: null }).where(eq(cardCoverage.status, "suspected_omission"));
      const calls = await db.$count(llmCalls);
      const found = await screenStoredNoAssertions(db, depositionIds[0]);
      expect(found.length).toBeGreaterThan(0);
      expect(await screenStoredNoAssertions(db, depositionIds[0])).toEqual([]);
      expect(await db.$count(llmCalls)).toBe(calls);
    });
  });

  it("a failed call fails its chunk, keeps the others, and is retried by the next run", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel({ fail: (call) => (call === 2 ? new Error("overloaded") : null) }), { concurrency: 1 });
    expect(r.chunks.failed).toBe(1);
    const failed = await db.select().from(cardCoverage).where(eq(cardCoverage.status, "failed"));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].error).toContain("overloaded");
    await extractCards(db, depositionIds[0], mockCardModel());
    expect((await coverageOf(db, depositionIds[0])).failed).toBe(0);
  });

  it("stops after repeated failures, leaving the rest not_processed", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel({ fail: () => new Error("down") }), { concurrency: 1 });
    expect(r.stopped).toBe("failures");
    expect(r.chunks.sent).toBe(3);
    expect(r.coverage.not_processed).toBeGreaterThan(0);
  });

  it("a chunk cut off at the token limit is split and sent again, losing nothing", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel({ stopReason: (call) => (call === 1 ? "max_tokens" : "end_turn") }), { concurrency: 1 });
    expect(r.chunks.split).toBe(1);
    expect(r.coverage.failed).toBe(0);
    expect(r.coverage.not_processed).toBe(0);
  });

  it("a refusal fails its parts without a card", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel({ stopReason: () => "refusal" }), { maxChunks: 1 });
    expect(r.coverage.failed).toBeGreaterThan(0);
    expect(await db.$count(statementCards)).toBe(0);
  });

  it("a budget stops before a call it can't cover, and a larger one continues", async () => {
    const small = await ensureBudget(db, "cards-small", 0.0001);
    const stopped = await extractCards(db, depositionIds[0], mockCardModel(), { budgetId: small, concurrency: 1 });
    expect(stopped.stopped).toBe("budget");
    expect(stopped.chunks.sent).toBe(0);
    expect((await budgetStatus(db, small)).reservedUsd).toBe(0);
    const large = await ensureBudget(db, "cards-large", 1);
    const done = await extractCards(db, depositionIds[0], mockCardModel(), { budgetId: large });
    expect(done.stopped).toBeNull();
    const after = await budgetStatus(db, large);
    expect(after.reservedUsd).toBe(0);
    expect(after.spentUsd).toBeGreaterThan(0);
  });

  it("one named budget is shared across runs and sessions, whatever the limit passed", async () => {
    const budget = await ensureBudget(db, "shared", 0.1);
    expect(await ensureBudget(db, "shared", 0.1)).toBe(budget);
    await expect(ensureBudget(db, "shared", 0.2)).rejects.toThrow("never changed silently");
    await extractCards(db, depositionIds[0], mockCardModel(), { budgetId: budget, maxChunks: 1 });
    await extractCards(db, depositionIds[1], mockCardModel(), { budgetId: budget, maxChunks: 1 });
    expect((await budgetStatus(db, budget)).spentUsd).toBeGreaterThan(0);
    const { reservations } = (await db.execute<{ reservations: number }>(sql`select count(*)::int as reservations from budget_reservations where budget_id = ${budget}`)).rows[0];
    expect(reservations).toBe(2);
  });

  it("reserves before every call, so concurrent chunks can't exceed what the budget covers", async () => {
    const one = maxRequestCost(mockCardModel().model, { inputTokens: 40_000, maxOutputTokens: CARD_MAX_OUTPUT_TOKENS });
    const budget = await ensureBudget(db, "tight", one * 2);
    const model = mockCardModel();
    const r = await extractCards(db, depositionIds[0], model, { budgetId: budget, concurrency: 5 });
    const after = await budgetStatus(db, budget);
    expect(r.stopped).toBe("budget");
    expect(model.calls).toBe(r.chunks.sent);
    expect(model.calls).toBeLessThan(r.chunks.planned);
    expect(after.reservedUsd).toBe(0);
    expect(after.spentUsd).toBeLessThanOrEqual(after.limitUsd);
  });

  it("maxChunks is a ceiling on calls: a cut-off chunk fails instead of being split", async () => {
    const model = mockCardModel({ stopReason: () => "max_tokens" });
    const r = await extractCards(db, depositionIds[0], model, { maxChunks: 2 });
    expect(model.calls).toBe(2);
    expect(r.chunks.split).toBe(0);
    expect(r.coverage.failed).toBeGreaterThan(0);
  });

  it("a cancel stops before the next chunk", async () => {
    const r = await extractCards(db, depositionIds[0], mockCardModel(), { shouldStop: async () => true });
    expect(r).toMatchObject({ stopped: "cancelled", chunks: { sent: 0 } });
  });

  it("plans the same chunks a run would send", async () => {
    const planned = await plannedChunks(db, depositionIds[0]);
    const r = await extractCards(db, depositionIds[0], mockCardModel());
    expect(planned.length).toBe(r.chunks.planned);
    expect(await plannedChunks(db, depositionIds[0])).toEqual([]);
  });

  it("refuses a deposition that doesn't exist", async () => {
    await expect(extractCards(db, 999999, mockCardModel())).rejects.toThrow("doesn't exist");
  });

  describe("topic map", () => {
    const fixed = (topicsReply: unknown, stopReason = "end_turn"): ClaimModel => ({ model: "claude-haiku-5-5", extract: async () => ({ stopReason, usage: { input_tokens: 1, output_tokens: 1 } as never, text: JSON.stringify({ topics: topicsReply }) }) });
    const usableIds = async (d: number) => (await db.select({ id: statementCards.id }).from(statementCards).where(and(eq(statementCards.depositionId, d), eq(statementCards.status, "usable")))).map((c) => c.id);

    it("gives every usable card one primary, counting unassigned ones", async () => {
      for (const d of depositionIds) await extractCards(db, d, mockCardModel());
      const r = await buildTopicMap(db, witnessId, mockTopicModel());
      expect(r).toMatchObject({ status: "built", mapVersion: 1 });
      const members = await mapMembers(db, witnessId, 1);
      const primaries = members.filter((m) => m.isPrimary);
      expect(new Set(primaries.map((m) => m.cardId)).size).toBe(primaries.length);
      expect(primaries.length).toBe(await db.$count(statementCards, eq(statementCards.status, "usable")));
      expect(r.report!.assigned + r.report!.unassigned).toBe(r.report!.cards);
    });

    it("stores primary and secondary memberships and counts sessions", async () => {
      await extractCards(db, depositionIds[0], mockCardModel());
      await extractCards(db, depositionIds[1], mockCardModel());
      const [one, two] = [await usableIds(depositionIds[0]), await usableIds(depositionIds[1])];
      await buildTopicMap(db, witnessId, fixed([{ name: "Both", primary: [`C${one[0]}`, `C${two[0]}`], secondary: [] }, { name: "Extra", primary: [], secondary: [`C${one[0]}`] }]));
      const stored = await db.select().from(topics).where(eq(topics.mapVersion, 1));
      expect(stored.find((t) => t.name === "Both")!.sessions).toBe(2);
      expect(stored.filter((t) => t.isUnassigned)).toHaveLength(1);
      expect((await db.select().from(cardTopics).where(eq(cardTopics.cardId, one[0]))).map((m) => m.isPrimary).sort()).toEqual([false, true]);
    });

    it("an unchanged witness costs nothing and makes no new version", async () => {
      await extractCards(db, depositionIds[0], mockCardModel());
      await buildTopicMap(db, witnessId, mockTopicModel());
      const again = mockTopicModel();
      expect(await buildTopicMap(db, witnessId, again)).toMatchObject({ status: "unchanged", mapVersion: 1 });
      expect(again.calls).toBe(0);
    });

    it("a new session makes a new version, reading only its cards and keeping the old memberships", async () => {
      await extractCards(db, depositionIds[0], mockCardModel());
      await buildTopicMap(db, witnessId, mockTopicModel());
      const old = (await mapMembers(db, witnessId, 1)).length;
      await extractCards(db, depositionIds[1], mockCardModel());
      const newCards = new Set((await usableIds(depositionIds[1])).map((id) => `C${id}`));
      const sent: string[] = [];
      const spy = mockTopicModel();
      const r = await buildTopicMap(db, witnessId, { model: spy.model, extract: (text) => (sent.push(text), spy.extract(text)) });
      expect(r).toMatchObject({ status: "built", mapVersion: 2 });
      expect([...sent[0].matchAll(/\[(C\d+)\]/g)].every((m) => newCards.has(m[1]))).toBe(true);
      expect((await mapMembers(db, witnessId, 2)).length).toBeGreaterThan(old);
      expect((await mapMembers(db, witnessId, 1)).length).toBe(old);
    });

    it("reads a large witness in parts, each seeing the topics so far", async () => {
      await extractCards(db, depositionIds[0], mockCardModel());
      const spy = mockTopicModel();
      const sent: string[] = [];
      await buildTopicMap(db, witnessId, { model: spy.model, extract: (text) => (sent.push(text), spy.extract(text)) }, { maxCards: 100 });
      expect(sent.length).toBeGreaterThan(1);
      expect(sent[1]).toContain("Existing topics:");
    });

    it("a failed map stores nothing and reports why", async () => {
      await extractCards(db, depositionIds[0], mockCardModel());
      const bad: ClaimModel = { model: "claude-haiku-5-5", extract: async () => ({ stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } as never, text: "not json" }) };
      expect(await buildTopicMap(db, witnessId, bad)).toMatchObject({ status: "failed", error: "the output doesn't match the topic schema" });
      expect(await latestMapVersion(db, witnessId)).toBeNull();
      const down: ClaimModel = { model: "claude-haiku-5-5", extract: async () => { throw new Error("down"); } };
      expect((await buildTopicMap(db, witnessId, down)).error).toContain("down");
    });

    it("no cards means no call", async () => {
      const m = mockTopicModel();
      expect(await buildTopicMap(db, witnessId, m)).toMatchObject({ status: "no_cards", mapVersion: null });
      expect(m.calls).toBe(0);
    });

    it("keeps to the current extractor version", () => {
      expect(CARD_EXTRACTOR_VERSION).toContain("cards-v2");
    });
  });
});
