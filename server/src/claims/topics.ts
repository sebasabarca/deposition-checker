// Builds a witness's topic map (DESIGN.md `buildTopicMap`): every usable card from the witness's
// ready sessions, once per change. A new map version keeps the memberships already made and reads
// only cards the last map hasn't seen, and a witness with too many cards for one call is read in
// parts the same way, each part seeing the topics so far. A failed map stores nothing: Path A still
// has its entity links and Path B doesn't need topics.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { BudgetExceeded, closeFailed, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { cardTopics, depositions, statementCards, topics } from "../db/schema";
import { CARD_EXTRACTOR_VERSION } from "./cardPrompt";
import type { ClaimModel } from "./model";
import { formatTopicInput, MAX_CARDS_PER_CALL, readTopicMap, TOPIC_MAX_OUTPUT_TOKENS, TOPICS_JSON_SCHEMA, TOPICS_SYSTEM_PROMPT, topicReport, UNASSIGNED, type TopicCard, type TopicMember, type TopicReport } from "./topicMap";

export type TopicMapResult = {
  status: "built" | "unchanged" | "no_cards" | "failed";
  mapVersion: number | null;
  error: string | null;
  calls: number;
  unknownCards: number;
  duplicates: number;
  report: TopicReport | null;
};

export const latestMapVersion = async (db: Database, witnessId: number): Promise<number | null> => {
  const [row] = await db.select({ v: sql<number | null>`max(${topics.mapVersion})` }).from(topics).where(eq(topics.witnessId, witnessId));
  return row?.v ?? null;
};

export async function mapMembers(db: Database, witnessId: number, mapVersion: number): Promise<TopicMember[]> {
  return db
    .select({ topic: topics.name, isUnassigned: topics.isUnassigned, isPrimary: cardTopics.isPrimary, cardId: cardTopics.cardId, depositionId: statementCards.depositionId })
    .from(cardTopics)
    .innerJoin(topics, eq(topics.id, cardTopics.topicId))
    .innerJoin(statementCards, eq(statementCards.id, cardTopics.cardId))
    .where(and(eq(topics.witnessId, witnessId), eq(cardTopics.mapVersion, mapVersion)));
}

export async function buildTopicMap(db: Database, witnessId: number, model: ClaimModel, { budgetId, jobId = null, maxCards = MAX_CARDS_PER_CALL }: { budgetId?: number; jobId?: number | null; maxCards?: number } = {}): Promise<TopicMapResult> {
  const result: TopicMapResult = { status: "built", mapVersion: null, error: null, calls: 0, unknownCards: 0, duplicates: 0, report: null };
  const cards: (TopicCard & { depositionId: number })[] = (
    await db
      .select({ id: statementCards.id, event: statementCards.event, depositionId: statementCards.depositionId })
      .from(statementCards)
      .innerJoin(depositions, eq(depositions.id, statementCards.depositionId))
      .where(and(eq(statementCards.witnessId, witnessId), eq(statementCards.status, "usable"), eq(statementCards.extractorVersion, CARD_EXTRACTOR_VERSION), eq(depositions.status, "ready"), isNull(depositions.excludedReason)))
      .orderBy(asc(statementCards.id))
  ).map((c) => ({ ...c, event: c.event! }));
  if (cards.length === 0) return { ...result, status: "no_cards" };

  const current = new Set(cards.map((c) => c.id));
  const latest = await latestMapVersion(db, witnessId);
  const prior = latest === null ? [] : (await mapMembers(db, witnessId, latest)).filter((m) => current.has(m.cardId));
  const mapped = new Set(prior.map((m) => m.cardId));
  const missing = cards.filter((c) => !mapped.has(c.id));
  if (latest !== null && missing.length === 0) return { ...result, status: "unchanged", mapVersion: latest, report: topicReport(prior) };

  // What the new version holds: prior memberships, then each response's.
  const map = new Map<string, { primary: Set<number>; secondary: Set<number> }>();
  const unassigned = new Set<number>();
  const topicOf = (name: string) => {
    if (!map.has(name)) map.set(name, { primary: new Set(), secondary: new Set() });
    return map.get(name)!;
  };
  for (const m of prior) {
    if (m.isUnassigned && m.isPrimary) unassigned.add(m.cardId);
    else if (!m.isUnassigned) (m.isPrimary ? topicOf(m.topic).primary : topicOf(m.topic).secondary).add(m.cardId);
  }

  let firstCall: number | null = null;
  const assign = async (batch: readonly TopicCard[]): Promise<string | null> => {
    const existing = [...map.keys()];
    const text = formatTopicInput(batch, existing);
    let reservation: number | null = null;
    if (budgetId !== undefined) reservation = await reserve(db, budgetId, maxRequestCost(model.model, { inputTokens: inputTokenBound(TOPICS_SYSTEM_PROMPT.length + JSON.stringify(TOPICS_JSON_SCHEMA).length + text.length), maxOutputTokens: TOPIC_MAX_OUTPUT_TOKENS }), `topic_mapping witness ${witnessId}, ${batch.length} cards`);
    const started = performance.now();
    let reply;
    try {
      reply = await model.extract(text);
    } catch (error) {
      if (reservation !== null) await closeFailed(db, reservation, error);
      return `call failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
    }
    const call = await recordCall(db, { jobId, stage: "topic_mapping", model: model.model, usage: reply.usage, attempt: 1, items: batch.length, rawOutput: reply.text, effort: "low", latencyMs: Math.round(performance.now() - started) });
    if (reservation !== null) await settle(db, reservation, call);
    result.calls++;
    firstCall ??= call.id;
    if (reply.stopReason === "max_tokens" && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      return (await assign(batch.slice(0, middle))) ?? assign(batch.slice(middle));
    }
    const reading = readTopicMap(batch.map((c) => c.id), reply, existing);
    if (reading.unusable) return reading.unusable;
    result.unknownCards += reading.unknownCards.length;
    result.duplicates += reading.duplicates;
    for (const t of reading.topics) {
      for (const id of t.primary) topicOf(t.name).primary.add(id);
      for (const id of t.secondary) topicOf(t.name).secondary.add(id);
    }
    for (const id of reading.unassigned) unassigned.add(id);
    return null;
  };

  try {
    for (let i = 0; i < missing.length; i += maxCards) {
      const error = await assign(missing.slice(i, i + maxCards));
      if (error) return { ...result, status: "failed", error };
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) return { ...result, status: "failed", error: error.message };
    throw error;
  }

  const sessionOf = new Map(cards.map((c) => [c.id, c.depositionId]));
  const sessions = (ids: Iterable<number>) => new Set([...ids].map((id) => sessionOf.get(id))).size;
  // Two builds at once collide on the unique topic names and the one unassigned topic per version.
  const mapVersion = await db.transaction(async (tx) => {
    const version = ((await latestMapVersion(tx as unknown as Database, witnessId)) ?? 0) + 1;
    const rows = [
      { witnessId, mapVersion: version, name: UNASSIGNED, sessions: sessions(unassigned), isUnassigned: true, llmCallId: firstCall },
      ...[...map].map(([name, t]) => ({ witnessId, mapVersion: version, name, sessions: sessions([...t.primary, ...t.secondary]), isUnassigned: false, llmCallId: firstCall })),
    ];
    const inserted = await tx.insert(topics).values(rows).returning({ id: topics.id, name: topics.name });
    const idOf = new Map(inserted.map((t) => [t.name, t.id]));
    const members = [
      ...[...unassigned].map((cardId) => ({ topicId: idOf.get(UNASSIGNED)!, cardId, mapVersion: version, isPrimary: true })),
      ...[...map].flatMap(([name, t]) => [...[...t.primary].map((cardId) => ({ topicId: idOf.get(name)!, cardId, mapVersion: version, isPrimary: true })), ...[...t.secondary].filter((id) => !t.primary.has(id)).map((cardId) => ({ topicId: idOf.get(name)!, cardId, mapVersion: version, isPrimary: false }))]),
    ];
    for (let i = 0; i < members.length; i += 1000) await tx.insert(cardTopics).values(members.slice(i, i + 1000));
    return version;
  });
  return { ...result, mapVersion, report: topicReport(await mapMembers(db, witnessId, mapVersion)) };
}
