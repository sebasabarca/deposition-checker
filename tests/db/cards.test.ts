// The Milestone 1 tables against Postgres: what the database itself guarantees about cards, coverage,
// topics and provenance. See tests/db/database.ts for when these run.

import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { candidates, candidateTopics, cardCoverage, cardTopics, exchanges, llmCalls, statementCards, topics } from "../../server/src/db/schema";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { provenanceOf } from "../../server/src/retrieve/provenance";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("statement cards, topics and provenance (Postgres)", () => {
  let db: Database;
  let pool: Pool;
  let c: typeof candidates.$inferSelect;
  let call: number;
  const version = "cards-v1+test";

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    const ids = await storeSynthetic(db, WEBB_SUITE);
    [c] = await db.select().from(candidates).where(eq(candidates.id, [...ids.values()][0]));
    [{ id: call }] = await db.insert(llmCalls).values({ stage: "statement_cards", model: "claude-haiku-5-5", items: 1, inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, attempt: 1 }).returning();
  });

  const card = (key: string, over: Partial<typeof statementCards.$inferInsert> = {}) => ({
    cardKey: key, exchangeId: c.exchangeA, citedExchange: `E${c.exchangeA}`, depositionId: c.depositionA, witnessId: c.witnessId, extractorVersion: version, ordinal: 0,
    sourcePhrase: "words", firstLineId: firstLine, lastLineId: firstLine, statement: "A statement.", event: "An event", subject: "Webb", predicate: "went", stance: "asserts" as const, epistemic: "asserted" as const,
    status: "usable" as const, raw: {}, llmCallId: call, ...over,
  });
  let firstLine: number;
  beforeEach(async () => {
    [{ id: firstLine }] = await db.select({ id: exchanges.firstLineId }).from(exchanges).where(eq(exchanges.id, c.exchangeA));
  });
  const insertCard = async (key: string, over = {}) => (await db.insert(statementCards).values(card(key, over)).returning())[0];
  const topic = async (name: string, over = {}) => (await db.insert(topics).values({ witnessId: c.witnessId, mapVersion: 1, name, ...over }).returning())[0];

  it("holds several cards on one exchange, and none twice on a re-run", async () => {
    await insertCard("a");
    await insertCard("b", { ordinal: 1 });
    await db.insert(statementCards).values(card("a")).onConflictDoNothing();
    expect(await db.$count(statementCards)).toBe(2);
  });

  it("refuses a usable card with no source span or fields, but keeps a rejected one with its reason", async () => {
    await expect(insertCard("x", { firstLineId: null })).rejects.toThrow();
    await expect(insertCard("y", { stance: null })).rejects.toThrow();
    await expect(insertCard("z", { status: "rejected" })).rejects.toThrow();
    const kept = await insertCard("r", { status: "rejected", rejectionReason: "unknown_exchange", exchangeId: null, firstLineId: null, lastLineId: null, statement: null, stance: null, raw: { bad: true } });
    expect(kept.raw).toEqual({ bad: true });
  });

  it("refuses a card whose exchange or witness isn't its session's", async () => {
    await expect(insertCard("x", { depositionId: c.depositionB })).rejects.toThrow();
    await expect(insertCard("y", { witnessId: c.witnessId + 999 })).rejects.toThrow();
  });

  it("coverage has one row per exchange and version, and a rerun updates it", async () => {
    const row = { exchangeId: c.exchangeA, extractorVersion: version, depositionId: c.depositionA };
    await db.insert(cardCoverage).values({ ...row, status: "failed", error: "cut off" });
    await db.insert(cardCoverage).values({ ...row, status: "carded", cards: 2 }).onConflictDoUpdate({ target: [cardCoverage.exchangeId, cardCoverage.extractorVersion], set: { status: "carded", cards: 2, error: null } });
    const rows = await db.select().from(cardCoverage);
    expect(rows.map((r) => [r.status, r.cards])).toEqual([["carded", 2]]);
    await expect(db.insert(cardCoverage).values({ ...row, extractorVersion: "v2", status: "failed" })).rejects.toThrow();
    await expect(db.insert(cardCoverage).values({ ...row, extractorVersion: "v3", status: "carded", cards: 0 })).rejects.toThrow();
    await db.insert(cardCoverage).values({ ...row, extractorVersion: "v4", status: "no_assertion" });
  });

  it("a card has one primary topic and any number of secondary ones", async () => {
    const card1 = await insertCard("a");
    const [one, two, three] = [await topic("Pricing"), await topic("Negotiations"), await topic("Strategy")];
    await db.insert(cardTopics).values([{ topicId: one.id, cardId: card1.id, mapVersion: 1, isPrimary: true }, { topicId: two.id, cardId: card1.id, mapVersion: 1 }, { topicId: three.id, cardId: card1.id, mapVersion: 1 }]);
    expect(await db.$count(cardTopics)).toBe(3);
    const other = await topic("Other");
    await expect(db.insert(cardTopics).values({ topicId: other.id, cardId: card1.id, mapVersion: 1, isPrimary: true })).rejects.toThrow();
  });

  it("the same card can have a new primary under a new map version, and a membership can't claim the wrong version", async () => {
    const card1 = await insertCard("a");
    const v1 = await topic("Pricing");
    const v2 = await topic("Pricing", { mapVersion: 2 });
    await db.insert(cardTopics).values([{ topicId: v1.id, cardId: card1.id, mapVersion: 1, isPrimary: true }, { topicId: v2.id, cardId: card1.id, mapVersion: 2, isPrimary: true }]);
    await expect(db.insert(cardTopics).values({ topicId: (await topic("X")).id, cardId: card1.id, mapVersion: 2 })).rejects.toThrow();
  });

  it("each map version has one explicit unassigned topic", async () => {
    await topic("Unassigned", { isUnassigned: true });
    await expect(topic("Unassigned too", { isUnassigned: true })).rejects.toThrow();
    await topic("Unassigned", { isUnassigned: true, mapVersion: 2 });
  });

  it("one candidate records Path A, Path B or both, and all its topics", async () => {
    const pair = { candidateSet: "s", witnessId: c.witnessId, depositionA: c.depositionA, groupA: c.groupA, depositionB: c.depositionB, groupB: c.groupB, exchangeA: c.exchangeA, exchangeB: c.exchangeB, rrfScore: 0, mergedRank: 1, evidence: [], retrievalVersion: "hybrid-v1" };
    const [both] = await db.insert(candidates).values({ ...pair, sources: ["topics", "fulltext"], rankTopics: 3, rankFulltext: 9, mapVersion: 1, selectedBy: "path_a" }).returning();
    expect(provenanceOf(both.sources)).toBe("both");
    await expect(db.insert(candidates).values({ ...pair, sources: ["fulltext"] })).rejects.toThrow(); // the same pair twice
    const [one, two] = [await topic("Pricing"), await topic("Negotiations")];
    await db.insert(candidateTopics).values([{ candidateId: both.id, topicId: one.id }, { candidateId: both.id, topicId: two.id }]);
    expect(await db.$count(candidateTopics)).toBe(2);
  });

  it("an excluded candidate needs its reason, and selected_by is a known path", async () => {
    await expect(db.update(candidates).set({ status: "excluded" }).where(eq(candidates.id, c.id))).rejects.toThrow();
    await db.update(candidates).set({ status: "excluded", exclusionReason: "procedural" }).where(eq(candidates.id, c.id));
    await expect(db.update(candidates).set({ selectedBy: "path_c" }).where(eq(candidates.id, c.id))).rejects.toThrow();
  });

  it("re-ingesting an exchange removes its cards with it", async () => {
    await insertCard("a");
    await db.execute(sql`delete from exchanges where id = ${c.exchangeA}`);
    expect(await db.$count(statementCards)).toBe(0);
  });
});
