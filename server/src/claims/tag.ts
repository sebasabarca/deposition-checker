// Tags a deposition's exchange parts with claims (DESIGN.md `tagClaims`). Every part attempted is
// recorded as tagged, failed or refused; every claim the model returned is kept, rejected ones with
// their reason; every model response is recorded with recordCall. A re-run of the same extractor
// version skips the parts already tagged and retries the rest. Failure never blocks Path B.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { claims, claimTagging, depositions, exchangeLines, exchanges, lines } from "../db/schema";
import { closeFailed, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../costs";
import { proceduralReason } from "../retrieve/procedural";
import { normalizeEntities } from "./entities";
import type { ClaimModel } from "./model";
import { BATCH_SIZE, EXTRACTOR_VERSION, exchangeLabel, formatBatch, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, type BatchPart } from "./prompt";
import { EXTRACTION_JSON_SCHEMA } from "./schema";
import { ExtractionOutput, type ExtractedClaim } from "./schema";
import { checkClaim, type ClaimCheck, type PartLine } from "./verify";
import { timed } from "../timing";

export type TagPart = BatchPart & { lines: PartLine[]; flags: string[] };

export type TagResult = {
  parts: { attempted: number; tagged: number; failed: number; refused: number; skipped: number };
  claims: { verified: number; approximate: number; rejected: number; rejectionReasons: Record<string, number> };
  llmCallIds: number[];
};

// The deposition's testimony parts not yet tagged by this extractor version, with their lines.
export async function partsToTag(db: Database, depositionId: number): Promise<{ parts: TagPart[]; skipped: number }> {
  const [deposition] = await db.select({ status: depositions.status }).from(depositions).where(eq(depositions.id, depositionId));
  if (!deposition) throw new Error(`Deposition ${depositionId} doesn't exist.`);
  if (deposition.status !== "ready") throw new Error(`Deposition ${depositionId} is ${deposition.status}; only ready depositions are tagged.`);

  const all = await db
    .select({ id: exchanges.id, kind: exchanges.kind, questionText: exchanges.questionText, dialogueText: exchanges.dialogueText, flags: exchanges.flags })
    .from(exchanges)
    .where(eq(exchanges.depositionId, depositionId))
    .orderBy(asc(exchanges.id));
  const done = new Set(
    (
      await db
        .select({ id: claimTagging.exchangeId })
        .from(claimTagging)
        .where(and(eq(claimTagging.depositionId, depositionId), eq(claimTagging.extractorVersion, EXTRACTOR_VERSION), eq(claimTagging.status, "tagged")))
    ).map((r) => r.id),
  );
  const todo = all.filter((p) => proceduralReason(p) === null && !done.has(p.id));
  if (todo.length === 0) return { parts: [], skipped: done.size };
  const linesOf = await partLines(db, todo.map((p) => p.id));
  return { parts: todo.map((p) => ({ id: p.id, dialogueText: p.dialogueText, flags: p.flags, lines: linesOf.get(p.id) ?? [] })), skipped: done.size };
}

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

export function batchesOf<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export async function tagClaims(
  db: Database,
  depositionId: number,
  model: ClaimModel,
  {
    maxBatches,
    batchSize = BATCH_SIZE,
    only,
    budgetId,
  }: { maxBatches?: number; batchSize?: number; only?: readonly number[]; budgetId?: number } = {},
): Promise<TagResult> {
  const [deposition] = await db.select({ witnessId: depositions.witnessId }).from(depositions).where(eq(depositions.id, depositionId));
  const pending = await partsToTag(db, depositionId);
  // `only` restricts the run to chosen parts (a pilot sample), still skipping any already tagged.
  const chosen = only ? new Set(only) : null;
  const parts = chosen ? pending.parts.filter((p) => chosen.has(p.id)) : pending.parts;
  const skipped = pending.skipped;
  const batches = batchesOf(parts, batchSize).slice(0, maxBatches);
  const result: TagResult = {
    parts: { attempted: 0, tagged: 0, failed: 0, refused: 0, skipped },
    claims: { verified: 0, approximate: 0, rejected: 0, rejectionReasons: {} },
    llmCallIds: [],
  };

  for (const batch of batches) {
    result.parts.attempted += batch.length;
    const mark = async (status: "failed" | "refused", error: string, llmCallId: number | null) => {
      await db
        .insert(claimTagging)
        .values(batch.map((p) => ({ exchangeId: p.id, extractorVersion: EXTRACTOR_VERSION, depositionId, status, claims: 0, error, llmCallId })))
        .onConflictDoUpdate({
          target: [claimTagging.exchangeId, claimTagging.extractorVersion],
          set: { status, claims: 0, error, llmCallId, updatedAt: new Date() },
        });
      result.parts[status] += batch.length;
    };

    // With a budget, the batch's worst-case cost is reserved before it is sent; BudgetExceeded stops
    // the run here, before the call, leaving these parts untagged for a later run.
    const batchText = formatBatch(batch);
    const reservation =
      budgetId === undefined
        ? null
        : await reserve(
            db,
            budgetId,
            maxRequestCost(model.model, {
              inputTokens: inputTokenBound(SYSTEM_PROMPT.length + JSON.stringify(EXTRACTION_JSON_SCHEMA).length + batchText.length),
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            }),
            `claim_tagging deposition ${depositionId}, ${batch.length} parts`,
          );
    let reply;
    const started = performance.now();
    try {
      reply = await timed("tag.api_call", () => model.extract(batchText), { depositionId, parts: batch.length });
    } catch (error) {
      if (reservation !== null) await closeFailed(db, reservation, error);
      await mark("failed", `call failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), null);
      continue;
    }
    // Every response is billed, refusals included, so every response is recorded, then settled.
    const call = await recordCall(db, { jobId: null, stage: "claim_tagging", model: model.model, usage: reply.usage, attempt: 1, items: batch.length, rawOutput: reply.text, latencyMs: Math.round(performance.now() - started) });
    if (reservation !== null) await settle(db, reservation, call);
    result.llmCallIds.push(call.id);

    if (reply.stopReason === "refusal") {
      await mark("refused", "the model declined this batch", call.id);
      continue;
    }
    if (reply.stopReason === "max_tokens") {
      await mark("failed", "the output was cut off at the token limit", call.id);
      continue;
    }
    let output: ExtractionOutput;
    try {
      output = ExtractionOutput.parse(JSON.parse(reply.text ?? ""));
    } catch (error) {
      await mark("failed", `invalid output: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), call.id);
      continue;
    }

    // Check every claim against its part's lines; a claim citing a part outside the batch is kept, rejected.
    const byLabel = new Map(batch.map((p) => [exchangeLabel(p.id), p]));
    const ordinals = new Map<string, number>();
    const perPart = new Map<number, number>();
    const rows = output.claims.map((c: ExtractedClaim) => {
      const part = byLabel.get(c.exchangeId);
      const ordinal = ordinals.get(c.exchangeId) ?? 0;
      ordinals.set(c.exchangeId, ordinal + 1);
      if (part) perPart.set(part.id, (perPart.get(part.id) ?? 0) + 1);
      const check: ClaimCheck = part
        ? checkClaim(c, part)
        : {
            status: "rejected",
            rejectionReason: "unknown_exchange",
            matchScore: 0,
            answerMatchScore: null,
            evidenceLineIds: [],
            hedge: null,
            contextDependent: false,
            contextReason: null,
            entities: [],
            ungroundedEntities: normalizeEntities(c.entities),
          };
      result.claims[check.status]++;
      if (check.rejectionReason) result.claims.rejectionReasons[check.rejectionReason] = (result.claims.rejectionReasons[check.rejectionReason] ?? 0) + 1;
      return {
        exchangeId: part?.id ?? null,
        citedExchange: c.exchangeId,
        depositionId,
        witnessId: deposition.witnessId,
        extractorVersion: EXTRACTOR_VERSION,
        ordinal,
        source: c.source,
        keyPhrase: c.keyPhrase,
        answerPhrase: c.source === "adopted_question" ? (c.answerPhrase ?? "") : null,
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        polarity: c.polarity,
        epistemic: c.epistemic,
        time: c.time,
        place: c.place,
        quantity: c.quantity,
        dependsOnEarlier: c.dependsOnEarlierExchange,
        ...check,
        llmCallId: call.id,
      };
    });

    // One transaction per batch: the claims and the parts' tagged status land together. Claims left
    // on these parts by an earlier attempt of the same extractor version are replaced, never
    // duplicated; a rejected claim that cited no part of its batch stays with the response it came from.
    await db.transaction(async (tx) => {
      await tx
        .delete(claims)
        .where(and(eq(claims.extractorVersion, EXTRACTOR_VERSION), inArray(claims.exchangeId, batch.map((p) => p.id))));
      if (rows.length > 0) await tx.insert(claims).values(rows);
      await tx
        .insert(claimTagging)
        .values(batch.map((p) => ({ exchangeId: p.id, extractorVersion: EXTRACTOR_VERSION, depositionId, status: "tagged" as const, claims: perPart.get(p.id) ?? 0, error: null, llmCallId: call.id })))
        .onConflictDoUpdate({
          target: [claimTagging.exchangeId, claimTagging.extractorVersion],
          set: { status: "tagged", claims: sql`excluded.claims`, error: null, llmCallId: call.id, updatedAt: new Date() },
        });
    });
    result.parts.tagged += batch.length;
  }
  return result;
}

// Re-applies code's checks to claims already stored, with no model call: what changes when the
// deterministic rules change (hedges, context, entity grounding) is recomputed from the model's
// stored reading and the stored lines. Returns how many claims changed in each respect.
export async function reverifyClaims(db: Database, depositionId: number, extractorVersion = EXTRACTOR_VERSION) {
  const rows = await db
    .select()
    .from(claims)
    .where(and(eq(claims.depositionId, depositionId), eq(claims.extractorVersion, extractorVersion)));
  const withPart = rows.filter((r) => r.exchangeId !== null);
  const partIds = [...new Set(withPart.map((r) => r.exchangeId!))];
  const linesOf = await partLines(db, partIds);
  const flagsOf = new Map(
    (partIds.length ? await db.select({ id: exchanges.id, flags: exchanges.flags }).from(exchanges).where(inArray(exchanges.id, partIds)) : []).map((e) => [e.id, e.flags]),
  );
  const changed = { status: 0, hedge: 0, contextDependent: 0, entities: 0 };
  for (const r of withPart) {
    const extracted: ExtractedClaim = {
      exchangeId: r.citedExchange,
      source: r.source,
      keyPhrase: r.keyPhrase,
      answerPhrase: r.answerPhrase,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      polarity: r.polarity,
      epistemic: r.epistemic,
      time: r.time,
      place: r.place,
      quantity: r.quantity,
      entities: [...r.entities, ...r.ungroundedEntities],
      dependsOnEarlierExchange: r.dependsOnEarlier ?? false,
    };
    const check = checkClaim(extracted, { lines: linesOf.get(r.exchangeId!) ?? [], flags: flagsOf.get(r.exchangeId!) ?? [] });
    if (check.status !== r.status) changed.status++;
    if (check.hedge !== r.hedge) changed.hedge++;
    if (check.contextDependent !== r.contextDependent) changed.contextDependent++;
    if (check.entities.join("|") !== r.entities.join("|")) changed.entities++;
    await db.update(claims).set(check).where(eq(claims.id, r.id));
  }
  return { claims: withPart.length, changed };
}
