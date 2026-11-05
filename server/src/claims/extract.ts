// Extracts statement cards for one deposition (DESIGN.md `extractCards`). The model reads chunks of
// about 10 pages; code checks every card (cards.ts) and every outcome is stored:
//   - every eligible qa part has a coverage row from the start, not_processed until a chunk says otherwise
//   - every card is kept, rejected ones with their reason
//   - every response is recorded with recordCall, and with a budget its worst case is reserved first
// A re-run of the same extractor version skips parts already carded or no_assertion, so a finished
// deposition costs nothing and an interrupted one continues. A chunk cut off at the token limit is
// split in two and sent again. Failure never blocks Path B, which doesn't read cards.

import { captureEpochs, fencedTransaction } from "../evidence/epoch";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { BudgetExceeded, closeFailed, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { cardCoverage, depositions, exchangeLines, exchanges, lines, statementCards } from "../db/schema";
import { runPool } from "../adjudicate/pool";
import { proceduralReason } from "../retrieve/procedural";
import { spoken } from "../verify";
import { CARD_EXTRACTOR_VERSION, CARD_MAX_OUTPUT_TOKENS, CARDS_SYSTEM_PROMPT, CHUNK_OVERLAP_PAGES, chunkByPages, PAGES_PER_CHUNK } from "./cardPrompt";
import { addressedShare, CARDS_JSON_SCHEMA, isNegated, mergeCoverage, MIN_ADDRESSED_SHARE, readCards, screenNoAssertion, type CardReading, type Chunk, type ChunkExchange, type Coverage, type CoverageStatus } from "./cards";
import type { ClaimModel } from "./model";
import { formatBatch } from "./prompt";
import type { PartLine } from "./verify";

export const CARD_CONCURRENCY = 5;
export const MAX_CONSECUTIVE_CHUNK_FAILURES = 3;
// A normal run leaves suspected_omission alone: only a targeted run sends those, so a noAssertion the
// model repeats can't be paid for again on every re-run.
const DONE: CoverageStatus[] = ["carded", "no_assertion", "suspected_omission"];
const CONTEXT_EXCHANGES = 2;

// targeted: re-extract suspected_omission parts (or just `only`), each with the exchanges before it as
// context, since a fragment read alone is how they were missed. maxChunks caps calls as usual.
export type ExtractOptions = { targeted?: boolean; budgetId?: number; jobId?: number | null; concurrency?: number; maxChunks?: number; only?: readonly number[]; shouldStop?: () => Promise<boolean> };

export type ExtractResult = {
  chunks: { planned: number; sent: number; split: number; failed: number };
  thinChunks: { llmCallId: number; parts: number; addressed: number }[]; // calls that addressed under half their parts
  cards: { usable: number; rejected: number; duplicates: number };
  rejectionReasons: Record<string, number>;
  unknownNoAssertion: number; // IDs the model listed that aren't in its chunk
  coverage: Record<CoverageStatus, number>;
  procedural: number;
  stopped: "budget" | "failures" | "cancelled" | null;
};

// Each part's member lines with their roles, in transcript order.
export async function partLines(db: Database, partIds: readonly number[]): Promise<Map<number, PartLine[]>> {
  const linesOf = new Map<number, PartLine[]>();
  if (partIds.length === 0) return linesOf;
  const memberRows = await db
    .select({ exchangeId: exchangeLines.exchangeId, id: lines.id, role: exchangeLines.role, text: lines.rawText })
    .from(exchangeLines)
    .innerJoin(lines, eq(lines.id, exchangeLines.lineId))
    .where(inArray(exchangeLines.exchangeId, [...partIds]))
    .orderBy(asc(lines.printedPage), asc(lines.lineNo));
  for (const r of memberRows) linesOf.set(r.exchangeId, [...(linesOf.get(r.exchangeId) ?? []), { id: r.id, role: r.role, text: r.text }]);
  return linesOf;
}

type EligiblePart = ChunkExchange & { dialogueText: string; firstPage: number; context?: string };

// The deposition's testimony parts in transcript order, split into those cards can come from and
// the procedural ones, which are counted but never sent.
async function eligibleParts(db: Database, depositionId: number) {
  const rows = await db
    .select({ id: exchanges.id, kind: exchanges.kind, witnessId: exchanges.witnessId, questionText: exchanges.questionText, dialogueText: exchanges.dialogueText, firstPage: lines.printedPage })
    .from(exchanges)
    .innerJoin(lines, eq(lines.id, exchanges.firstLineId))
    .where(eq(exchanges.depositionId, depositionId))
    .orderBy(asc(lines.printedPage), asc(lines.lineNo), asc(exchanges.id));
  const eligible = rows.filter((r) => r.kind === "qa" && proceduralReason(r) === null);
  return { eligible, procedural: rows.length - eligible.length };
}

// Each stored coverage row of the deposition, as readCards would have reported it.
async function storedCoverage(db: Database, depositionId: number): Promise<Coverage[]> {
  const rows = await db.select().from(cardCoverage).where(and(eq(cardCoverage.depositionId, depositionId), eq(cardCoverage.extractorVersion, CARD_EXTRACTOR_VERSION)));
  return rows.map((r) => ({ exchangeId: r.exchangeId, status: r.status, cards: r.cards, error: r.error, signals: r.suspicionSignals }));
}

const contextBefore = (parts: readonly { id: number; dialogueText: string }[], id: number) => {
  const at = parts.findIndex((p) => p.id === id);
  return parts.slice(Math.max(0, at - CONTEXT_EXCHANGES), at).map((p) => p.dialogueText).join("\n");
};
const chunkText = (parts: readonly EligiblePart[]) => parts.map((p) => `${p.context ? `Context only, make no cards from this:\n${p.context}\n\n` : ""}${formatBatch([p])}`).join("\n\n");

export async function extractCards(db: Database, depositionId: number, model: ClaimModel, { targeted = false, budgetId, jobId = null, concurrency = CARD_CONCURRENCY, maxChunks, only, shouldStop }: ExtractOptions = {}): Promise<ExtractResult> {
  const [deposition] = await db.select({ status: depositions.status, witnessId: depositions.witnessId }).from(depositions).where(eq(depositions.id, depositionId));
  if (!deposition) throw new Error(`Deposition ${depositionId} doesn't exist.`);
  if (deposition.status !== "ready") throw new Error(`Deposition ${depositionId} is ${deposition.status}; only ready depositions get statement cards.`);

  const epochs = await captureEpochs(db, [depositionId]); // before reading the evidence: cards are stored only while it is current
  const { eligible, procedural } = await eligibleParts(db, depositionId);
  for (let i = 0; i < eligible.length; i += 500) {
    await db.insert(cardCoverage).values(eligible.slice(i, i + 500).map((e) => ({ exchangeId: e.id, extractorVersion: CARD_EXTRACTOR_VERSION, depositionId, status: "not_processed" as const }))).onConflictDoNothing();
  }
  const coverage = new Map((await storedCoverage(db, depositionId)).map((c) => [c.exchangeId, c]));
  const usable = await db.select({ key: statementCards.cardKey, exchangeId: statementCards.exchangeId }).from(statementCards).where(and(eq(statementCards.depositionId, depositionId), eq(statementCards.extractorVersion, CARD_EXTRACTOR_VERSION), eq(statementCards.status, "usable")));
  const seen = new Set(usable.map((r) => r.key));
  const carded = new Set(usable.map((r) => r.exchangeId!));

  const chosen = only ? new Set(only) : null;
  const isDue = (status: CoverageStatus) => (targeted ? status === "suspected_omission" : !DONE.includes(status));
  const todo = eligible.filter((e) => isDue(coverage.get(e.id)!.status) && (!chosen || chosen.has(e.id)));
  const linesOf = await partLines(db, todo.map((e) => e.id));
  const parts: EligiblePart[] = todo.map((e) => ({ id: e.id, depositionId, witnessId: e.witnessId, kind: e.kind, dialogueText: e.dialogueText, firstPage: e.firstPage, lines: linesOf.get(e.id) ?? [], context: targeted ? contextBefore(eligible, e.id) : undefined }));
  const chunks = chunkByPages(parts, PAGES_PER_CHUNK, targeted ? 0 : CHUNK_OVERLAP_PAGES).slice(0, maxChunks);

  const result: ExtractResult = { chunks: { planned: chunks.length, sent: 0, split: 0, failed: 0 }, thinChunks: [], cards: { usable: 0, rejected: 0, duplicates: 0 }, rejectionReasons: {}, unknownNoAssertion: 0, coverage: { carded: 0, no_assertion: 0, suspected_omission: 0, omitted: 0, failed: 0, not_processed: 0 }, procedural, stopped: null };

  // Chunks overlap and run at once, so readings are applied one at a time, in the order they finish:
  // `seen` and the merged coverage then always reflect everything saved before.
  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(step: () => Promise<T>) => {
    const run = tail.then(step);
    tail = run.catch(() => undefined);
    return run;
  };
  const save = (read: () => CardReading, llmCallId: number | null) =>
    inOrder(async () => {
      const reading = read();
      const merged = mergeCoverage(reading.coverage.map((c) => c.exchangeId), [{ coverage: reading.coverage.map((c) => coverage.get(c.exchangeId)!) }, reading]);
      await fencedTransaction(db, epochs, async (tx) => {
        if (reading.cards.length > 0) {
          await tx
            .insert(statementCards)
            .values(
              reading.cards.map((c) => ({
                cardKey: c.cardKey, exchangeId: c.exchangeId, citedExchange: c.citedExchange, depositionId, witnessId: deposition.witnessId, extractorVersion: CARD_EXTRACTOR_VERSION, ordinal: c.ordinal,
                sourcePhrase: c.card?.sourcePhrase ?? null, firstLineId: c.firstLineId, lastLineId: c.lastLineId, statement: c.card?.statement ?? null, event: c.card?.event ?? null, subject: c.card?.subject ?? null,
                entities: c.entities, ungroundedEntities: c.ungroundedEntities, predicate: c.card?.predicate ?? null, object: c.card?.object ?? null, time: c.card?.time ?? null, location: c.card?.location ?? null, amount: c.card?.amount ?? null,
                stance: c.card?.stance ?? null, epistemic: c.card?.epistemic ?? null, status: c.status, rejectionReason: c.rejectionReason, raw: c.raw ?? {}, llmCallId: llmCallId!,
              })),
            )
            .onConflictDoNothing();
        }
        await tx
          .insert(cardCoverage)
          .values(merged.map((c) => ({ exchangeId: c.exchangeId, extractorVersion: CARD_EXTRACTOR_VERSION, depositionId, status: c.status, cards: c.cards, error: c.error, llmCallId, suspicionSignals: [...(c.signals ?? [])], suspectedCallId: c.status === "suspected_omission" ? llmCallId : null })))
          .onConflictDoUpdate({
            target: [cardCoverage.exchangeId, cardCoverage.extractorVersion],
            set: {
              status: sql`excluded.status`, cards: sql`excluded.cards`, error: sql`excluded.error`, llmCallId, updatedAt: new Date(),
              // The first response that was doubted stays on record, whatever happens later.
              suspicionSignals: sql`case when cardinality(${cardCoverage.suspicionSignals}) > 0 then ${cardCoverage.suspicionSignals} else excluded.suspicion_signals end`,
              suspectedCallId: sql`coalesce(${cardCoverage.suspectedCallId}, excluded.suspected_call_id)`,
            },
          });
      });
      for (const c of merged) coverage.set(c.exchangeId, c);
      for (const c of reading.cards) {
        if (c.status === "usable") result.cards.usable++;
        else if (c.rejectionReason === "duplicate_card") result.cards.duplicates++;
        else {
          result.cards.rejected++;
          const reason = c.rejectionReason!.split(":")[0];
          result.rejectionReasons[reason] = (result.rejectionReasons[reason] ?? 0) + 1;
        }
      }
      result.unknownNoAssertion += reading.unknownNoAssertion.length;
      if (reading.unusable) result.chunks.failed++;
      const share = addressedShare(reading);
      if (share !== null && share < MIN_ADDRESSED_SHARE) result.thinChunks.push({ llmCallId: llmCallId!, parts: reading.coverage.length, addressed: Math.round(share * reading.coverage.length) });
    });

  let failures = 0;
  const send = async (part: readonly EligiblePart[]): Promise<"budget" | "failures" | null> => {
    const chunk: Chunk = { depositionId, witnessId: deposition.witnessId, exchanges: part };
    const text = chunkText(part);
    let reservation: number | null = null;
    if (budgetId !== undefined) {
      try {
        reservation = await reserve(db, budgetId, maxRequestCost(model.model, { inputTokens: inputTokenBound(CARDS_SYSTEM_PROMPT.length + JSON.stringify(CARDS_JSON_SCHEMA).length + text.length), maxOutputTokens: CARD_MAX_OUTPUT_TOKENS }), `statement_cards deposition ${depositionId}, ${part.length} parts`);
      } catch (error) {
        if (error instanceof BudgetExceeded) return "budget";
        throw error;
      }
    }
    result.chunks.sent++;
    const started = performance.now();
    let reply;
    try {
      reply = await model.extract(text);
    } catch (error) {
      if (reservation !== null) await closeFailed(db, reservation, error);
      const failedWith = `call failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
      await save(() => ({ ...readCards(chunk, null), unusable: failedWith, coverage: part.map((e) => ({ exchangeId: e.id, status: "failed" as const, cards: 0, error: failedWith })) }), null);
      return ++failures >= MAX_CONSECUTIVE_CHUNK_FAILURES ? "failures" : null;
    }
    // Every response is billed, refusals included, so every response is recorded, then settled.
    const call = await recordCall(db, { jobId, stage: "statement_cards", model: model.model, usage: reply.usage, attempt: 1, items: part.length, rawOutput: reply.text, effort: "low", latencyMs: Math.round(performance.now() - started) });
    if (reservation !== null) await settle(db, reservation, call);
    // maxChunks is a ceiling on calls, for pilots: a cut-off chunk there is recorded as failed, not split.
    if (reply.stopReason === "max_tokens" && part.length > 1 && maxChunks === undefined && !targeted) {
      result.chunks.split++;
      const middle = Math.ceil(part.length / 2);
      return (await send(part.slice(0, middle))) ?? send(part.slice(middle));
    }
    await save(() => readCards(chunk, reply, seen, carded), call.id);
    failures = 0;
    return null;
  };

  const pooled = await runPool(chunks, { concurrency, warmFirst: true }, async (chunk) => {
    if (await shouldStop?.()) return { stop: "cancelled" };
    const stop = await send(chunk);
    return stop ? { stop } : undefined;
  });
  await tail;
  result.stopped = pooled.stopped as ExtractResult["stopped"];
  for (const c of coverage.values()) result.coverage[c.status]++;
  return result;
}

export type CardSummary = {
  depositionId: number;
  parts: number; // exchange parts of the deposition
  procedural: number | null; // null until a run has counted them
  coverage: Record<CoverageStatus, number>;
  cards: { usable: number; rejected: number; duplicates: number; negatedStatements: number; sourceGroundingRate: number | null };
  rejectionReasons: Record<string, number>;
};

// One deposition's stored coverage and card counts. Duplicates from the chunk overlap aren't rejections:
// the source-grounding rate is the share of distinct cards code could accept.
export async function cardSummary(db: Database, depositionId: number, extractorVersion = CARD_EXTRACTOR_VERSION): Promise<CardSummary> {
  const parts = await db.$count(exchanges, eq(exchanges.depositionId, depositionId));
  const rows = await db.select({ status: cardCoverage.status, n: sql<number>`count(*)::int` }).from(cardCoverage).where(and(eq(cardCoverage.depositionId, depositionId), eq(cardCoverage.extractorVersion, extractorVersion))).groupBy(cardCoverage.status);
  const coverage: Record<CoverageStatus, number> = { carded: 0, no_assertion: 0, suspected_omission: 0, omitted: 0, failed: 0, not_processed: 0 };
  for (const r of rows) coverage[r.status] = r.n;
  const seeded = rows.reduce((n, r) => n + r.n, 0);
  const cards = await db.select({ status: statementCards.status, reason: statementCards.rejectionReason, n: sql<number>`count(*)::int` }).from(statementCards).where(and(eq(statementCards.depositionId, depositionId), eq(statementCards.extractorVersion, extractorVersion))).groupBy(statementCards.status, statementCards.rejectionReason);
  const totals = { usable: 0, rejected: 0, duplicates: 0 };
  const rejectionReasons: Record<string, number> = {};
  for (const c of cards) {
    if (c.status === "usable") totals.usable += c.n;
    else if (c.reason === "duplicate_card") totals.duplicates += c.n;
    else {
      totals.rejected += c.n;
      const reason = c.reason!.split(":")[0];
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + c.n;
    }
  }
  const statements = await db.select({ statement: statementCards.statement }).from(statementCards).where(and(eq(statementCards.depositionId, depositionId), eq(statementCards.extractorVersion, extractorVersion), eq(statementCards.status, "usable")));
  const negatedStatements = statements.filter((s) => isNegated(s.statement!)).length;
  const checked = totals.usable + totals.rejected;
  return { depositionId, parts, procedural: seeded === 0 ? null : parts - seeded, coverage, cards: { ...totals, negatedStatements, sourceGroundingRate: checked === 0 ? null : totals.usable / checked }, rejectionReasons };
}

// What a run would send, for the estimate and the pilot's exact scope. No model call, no writes.
export async function plannedChunks(db: Database, depositionId: number) {
  const { eligible } = await eligibleParts(db, depositionId);
  const coverage = new Map((await storedCoverage(db, depositionId)).map((c) => [c.exchangeId, c.status]));
  return chunkByPages(eligible.filter((e) => !DONE.includes(coverage.get(e.id) ?? "not_processed")));
}

// Applies the screen to noAssertion results already stored. Free, and safe to repeat: it changes only
// their status, keeping the response that said so. Returns the parts now suspected.
export async function screenStoredNoAssertions(db: Database, depositionId: number, extractorVersion = CARD_EXTRACTOR_VERSION) {
  const rows = await db
    .select({ id: cardCoverage.exchangeId, llmCallId: cardCoverage.llmCallId })
    .from(cardCoverage)
    .where(and(eq(cardCoverage.depositionId, depositionId), eq(cardCoverage.extractorVersion, extractorVersion), eq(cardCoverage.status, "no_assertion")));
  const linesOf = await partLines(db, rows.map((r) => r.id));
  const suspected: { exchangeId: number; signals: string[] }[] = [];
  for (const r of rows) {
    const text = (role: string) => (linesOf.get(r.id) ?? []).filter((l) => l.role === role).map((l) => spoken(l.text)).join(" ");
    const signals = screenNoAssertion(text("question"), text("answer"));
    if (signals.length === 0) continue;
    await db.update(cardCoverage).set({ status: "suspected_omission", suspicionSignals: signals, suspectedCallId: r.llmCallId, updatedAt: new Date() }).where(and(eq(cardCoverage.exchangeId, r.id), eq(cardCoverage.extractorVersion, extractorVersion)));
    suspected.push({ exchangeId: r.id, signals });
  }
  return suspected;
}
