// Stage 2: extracts source-grounded facts from one document's answer groups. The model reads batches of
// whole units; code checks every fact (verify.ts) and every outcome is stored:
//   - every unit has a coverage row from the start (store.ts syncUnits), pending until a response says otherwise
//   - every proposed fact is kept, rejected ones with their reason; only indexed ones are in the verified index
//   - every response is recorded with recordCall, and with a budget its worst case is reserved first
// A re-run sends only pending, failed and omitted units, so a finished document costs nothing and an
// interrupted one continues; fact keys make a retry unable to store a fact twice. A batch cut off at the
// token limit is split in two; a single unit cut off is marked incomplete, its testimony kept for retry.

import { and, eq, inArray, sql } from "drizzle-orm";
import { runPool } from "../../adjudicate/pool";
import { BudgetExceeded, closeFailed, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../../costs";
import type { Database } from "../../db/client";
import { factUnits, facts } from "../../db/schema";
import { heldDocuments } from "../../evidence/correction";
import { captureEpochs, withEvidenceFence } from "../../evidence/epoch";
import type { ClaimModel } from "../model";
import { FACT_EXTRACTOR_VERSION, factsJsonSchema, MAX_UNITS_PER_BATCH } from "./contracts";
import type { Unit } from "./context";
import { batchUnits, estimateFacts, FACT_MAX_OUTPUT_TOKENS, formatBatch, MAX_BATCH_CHARS, requestChars } from "./prompt";
import { DUE, factRow, storedFactKeys, syncUnits } from "./store";
import { readFacts, type FactReading } from "./verify";

export const FACT_CONCURRENCY = 3;
export const MAX_CONSECUTIVE_FAILURES = 3;

// only: the unit keys to consider (a pilot's windows); the others keep whatever status they have.
// unitsPerBatch: at most this many units per request (MAX_UNITS_PER_BATCH by default; 1 for critical runs).
export type FactExtractOptions = { budgetId?: number; jobId?: number | null; concurrency?: number; maxBatches?: number; only?: ReadonlySet<string>; unitsPerBatch?: number; shouldStop?: () => Promise<boolean> };
export type FactExtractResult = {
  units: number;
  staleUnits: number; // units whose source changed since their facts were extracted
  sourceChangedUnits: number; // units whose source changed while the model read them: not saved, still due
  batches: { planned: number; sent: number; split: number; failed: number };
  facts: { indexed: number; rejected: number; duplicates: number };
  rejectionReasons: Record<string, number>;
  stopped: string | null;
};

// What a run would send now, and its planning cost. No model call and no writes.
export async function planFacts(db: Database, documentId: number, only?: ReadonlySet<string>) {
  const { units, status, staleUnits } = await syncUnits(db, documentId, FACT_EXTRACTOR_VERSION, false);
  const due = units.filter((u) => DUE.includes(status.get(u.unitKey)!) && (!only || only.has(u.unitKey)));
  return { units: units.length, due: due.length, staleUnits, estimate: estimateFacts(batchUnits(due)) };
}

// Every unit outcome and fact is written through a connection declaring the evidence epoch read at the start
// (evidence/epoch.ts): if the transcript is corrected meanwhile, the database refuses the rest (stale_evidence).
export async function extractFacts(db: Database, documentId: number, model: ClaimModel, options: FactExtractOptions = {}): Promise<FactExtractResult> {
  const [held] = await heldDocuments(db, [documentId]);
  if (held) throw new Error(`Document ${documentId}'s evidence is held by ${held.hold}; extract after the correction.`);
  return withEvidenceFence(db, await captureEpochs(db, [documentId]), (fenced) => extractFenced(fenced, documentId, model, options));
}

async function extractFenced(db: Database, documentId: number, model: ClaimModel, { budgetId, jobId = null, concurrency = FACT_CONCURRENCY, maxBatches, only, unitsPerBatch = MAX_UNITS_PER_BATCH, shouldStop }: FactExtractOptions): Promise<FactExtractResult> {
  const { units, status, staleUnits } = await syncUnits(db, documentId);
  const due = units.filter((u) => DUE.includes(status.get(u.unitKey)!) && (!only || only.has(u.unitKey)));
  const batches = batchUnits(due, MAX_BATCH_CHARS, unitsPerBatch).slice(0, maxBatches);
  const seen = await storedFactKeys(db, documentId);
  const result: FactExtractResult = { units: units.length, staleUnits, sourceChangedUnits: 0, batches: { planned: batches.length, sent: 0, split: 0, failed: 0 }, facts: { indexed: 0, rejected: 0, duplicates: 0 }, rejectionReasons: {}, stopped: null };

  // Batches run at once, so readings are checked and saved one at a time: `seen` then always reflects
  // everything saved before, and two windows of one answer can't both store the same fact.
  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(step: () => Promise<T>) => {
    const run = tail.then(step);
    tail = run.catch(() => undefined);
    return run;
  };
  const save = (read: () => FactReading, llmCallId: number | null) =>
    inOrder(async () => {
      const reading = read();
      await db.transaction(async (tx) => {
        // The source may have changed while the model read it (an evidence correction): keep only the units
        // whose stored source hash is still the one sent; the rest stay due and are read again.
        const sent = new Map(units.map((u) => [u.unitKey, u.sourceHash]));
        const keys = reading.outcomes.map((o) => o.unitKey);
        const current = keys.length ? await tx.select({ key: factUnits.unitKey, hash: factUnits.sourceHash }).from(factUnits).where(and(inArray(factUnits.unitKey, keys), eq(factUnits.extractorVersion, FACT_EXTRACTOR_VERSION))) : [];
        const fresh = new Set(current.filter((r) => r.hash === sent.get(r.key)).map((r) => r.key));
        result.sourceChangedUnits += keys.filter((k) => !fresh.has(k)).length;
        reading.facts = reading.facts.filter((c) => fresh.has(c.unitKey));
        reading.outcomes = reading.outcomes.filter((o) => fresh.has(o.unitKey));
        const rows = reading.facts.map((c) => factRow(c, llmCallId));
        for (let i = 0; i < rows.length; i += 200) {
          // A stale fact found again in the changed source becomes current again; anything else is kept as is.
          await tx.insert(facts).values(rows.slice(i, i + 200)).onConflictDoUpdate({
            target: facts.factKey,
            set: { status: sql`excluded.status`, sourceHash: sql`excluded.source_hash`, sourceSpanIds: sql`excluded.source_span_ids`, lineIds: sql`excluded.line_ids`, exchangeId: sql`excluded.exchange_id`, attributionStatus: sql`excluded.attribution_status`, sourceVerification: sql`excluded.source_verification`, llmCallId: sql`excluded.llm_call_id` },
            setWhere: sql`${facts.status} = 'stale'`,
          });
        }
        for (const o of reading.outcomes) {
          await tx.update(factUnits).set({ status: o.status, facts: o.facts, rejected: o.rejected, duplicates: o.duplicates, error: o.error, llmCallId, attempts: sql`${factUnits.attempts} + 1`, updatedAt: new Date() })
            .where(and(eq(factUnits.unitKey, o.unitKey), eq(factUnits.extractorVersion, FACT_EXTRACTOR_VERSION)));
        }
      });
      for (const c of reading.facts) {
        if (c.status === "indexed") result.facts.indexed++;
        else {
          result.facts.rejected++;
          const reason = c.rejectionReason!.split(":")[0];
          result.rejectionReasons[reason] = (result.rejectionReasons[reason] ?? 0) + 1;
        }
      }
      result.facts.duplicates += reading.outcomes.reduce((n, o) => n + o.duplicates, 0);
      if (reading.unusable) result.batches.failed++;
    });
  const markIncomplete = (u: Unit, error: string, llmCallId: number | null) =>
    inOrder(() => db.update(factUnits).set({ status: "incomplete", error, llmCallId, attempts: sql`${factUnits.attempts} + 1`, updatedAt: new Date() }).where(and(eq(factUnits.unitKey, u.unitKey), eq(factUnits.extractorVersion, FACT_EXTRACTOR_VERSION))));

  let failures = 0;
  const send = async (batch: readonly Unit[]): Promise<string | null> => {
    const text = formatBatch(batch);
    let reservation: number | null = null;
    if (budgetId !== undefined) {
      try {
        reservation = await reserve(db, budgetId, maxRequestCost(model.model, { inputTokens: inputTokenBound(requestChars(batch)), maxOutputTokens: FACT_MAX_OUTPUT_TOKENS }), `fact_extraction document ${documentId}, ${batch.length} units`);
      } catch (error) {
        if (error instanceof BudgetExceeded) return "budget";
        throw error;
      }
    }
    result.batches.sent++;
    const started = performance.now();
    let reply;
    try {
      reply = await model.extract(text, factsJsonSchema(batch.length));
    } catch (error) {
      if (reservation !== null) await closeFailed(db, reservation, error);
      const failedWith = `call failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
      await save(() => ({ unusable: failedWith, facts: [], diagnostics: { unexpectedPositions: [], malformedGroups: 0, repeatedPositions: [], openingMismatches: [] }, outcomes: batch.map((u) => ({ unitKey: u.unitKey, status: "failed" as const, facts: 0, rejected: 0, duplicates: 0, error: failedWith })) }), null);
      return ++failures >= MAX_CONSECUTIVE_FAILURES ? "failures" : null;
    }
    // Every response is billed, refusals included, so every response is recorded, then settled.
    const call = await recordCall(db, { jobId, stage: "fact_extraction", model: model.model, usage: reply.usage, attempt: 1, items: batch.length, rawOutput: reply.text, effort: "low", latencyMs: Math.round(performance.now() - started) });
    if (reservation !== null) await settle(db, reservation, call);
    if (reply.stopReason === "max_tokens") {
      if (batch.length > 1) {
        result.batches.split++;
        const middle = Math.ceil(batch.length / 2);
        return (await send(batch.slice(0, middle))) ?? send(batch.slice(middle));
      }
      await markIncomplete(batch[0], "the response was cut off at the output limit even for this unit alone; its testimony is kept for another attempt", call.id);
      return null;
    }
    await save(() => readFacts(batch, reply, seen), call.id);
    failures = 0;
    return null;
  };

  const pooled = await runPool(batches, { concurrency, warmFirst: true }, async (batch) => {
    if (await shouldStop?.()) return { stop: "cancelled" };
    const stop = await send(batch);
    return stop ? { stop } : undefined;
  });
  await tail;
  result.stopped = pooled.stopped;
  return result;
}
