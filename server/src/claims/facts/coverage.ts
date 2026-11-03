// What Stage 2 has processed in a case, and what it hasn't: units by status, facts by outcome, and the
// measured tokens and cost of the calls that produced them. Read-only. Recall against labelled facts is
// not measured here: it needs real extractions (see evaluateRecall).

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { depositions, factUnits, facts, llmCalls, witnesses } from "../../db/schema";
import { contentTokens, FACT_EXTRACTOR_VERSION } from "./contracts";
import type { UnitStatus } from "./store";

const STATUSES: UnitStatus[] = ["pending", "extracted", "empty", "suspected_omission", "no_testimony", "omitted", "failed", "incomplete"];

export async function factCoverage(db: Database, caseId: number, extractorVersion = FACT_EXTRACTOR_VERSION) {
  const docs = await db.select({ id: depositions.id, witness: witnesses.name, status: depositions.status, excludedReason: depositions.excludedReason, duplicateOf: depositions.duplicateOf }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(eq(depositions.caseId, caseId)).orderBy(depositions.id);
  const active = docs.filter((d) => d.excludedReason === null);
  const documents = await Promise.all(active.map(async (d) => {
    const units = await db.select({ status: factUnits.status, groupId: factUnits.groupId, duplicates: factUnits.duplicates, llmCallId: factUnits.llmCallId }).from(factUnits).where(and(eq(factUnits.depositionId, d.id), eq(factUnits.extractorVersion, extractorVersion)));
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, units.filter((u) => u.status === s).length])) as Record<UnitStatus, number>;
    const factRows = await db.select({ status: facts.status, reason: facts.rejectionReason, attribution: facts.attributionStatus, source: facts.sourceVerification, semantic: facts.semanticStatus, llmCallId: facts.llmCallId }).from(facts).where(and(eq(facts.depositionId, d.id), eq(facts.extractorVersion, extractorVersion)));
    const indexed = factRows.filter((f) => f.status === "indexed");
    const rejectionReasons: Record<string, number> = {};
    for (const f of factRows.filter((x) => x.status === "rejected")) rejectionReasons[f.reason!.split(":")[0]] = (rejectionReasons[f.reason!.split(":")[0]] ?? 0) + 1;
    const callIds = [...new Set([...units, ...factRows].map((x) => x.llmCallId).filter((x): x is number => x !== null))];
    const [usage] = callIds.length
      ? await db.select({ calls: sql<number>`count(*)::int`, inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens} + ${llmCalls.cacheReadTokens} + ${llmCalls.cacheWrite5mTokens} + ${llmCalls.cacheWrite1hTokens}), 0)::int`, outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`, costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float`, unpriced: sql<number>`count(*) filter (where ${llmCalls.costUsd} is null)::int` }).from(llmCalls).where(inArray(llmCalls.id, callIds))
      : [{ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 }];
    return {
      documentId: d.id, witness: d.witness, status: d.status,
      answerGroups: new Set(units.map((u) => u.groupId)).size,
      units: { total: units.length, ...byStatus },
      // Units that hold testimony and have a final outcome, out of those that hold testimony.
      processed: { done: byStatus.extracted + byStatus.empty, eligible: units.length - byStatus.no_testimony },
      facts: {
        indexed: indexed.length,
        rejected: factRows.filter((f) => f.status === "rejected").length,
        stale: factRows.filter((f) => f.status === "stale").length,
        duplicatesAvoided: units.reduce((n, u) => n + u.duplicates, 0),
        attributionUncertain: indexed.filter((f) => f.attribution === "uncertain").length,
        sourceApproximate: indexed.filter((f) => f.source === "approximate").length,
        needsSemanticReview: indexed.filter((f) => f.semantic === "needs_semantic_review").length,
      },
      rejectionReasons,
      usage,
      notes: units.length === 0 ? ["not yet planned: no unit rows (run plan or extract)"] : [],
    };
  }));
  return {
    caseId, extractorVersion, documents,
    excluded: docs.filter((d) => d.excludedReason !== null).map((d) => ({ documentId: d.id, reason: d.excludedReason, duplicateOf: d.duplicateOf })),
  };
}

// Recall of labelled facts, for when real extractions exist: a labelled fact counts as found when an
// indexed fact of the same document shares one of its source lines and its dimension (or, without a
// labelled dimension, any indexed fact on its lines). Pure. Never reported from mocked extractions.
export type LabelledFact = { id: string; depositionId: number; lineIds: number[]; dimension?: string };
export function evaluateRecall(labels: readonly LabelledFact[], found: readonly { depositionId: number; lineIds: number[]; factualDimension: string | null }[]) {
  const hits = labels.map((l) => ({ id: l.id, found: found.some((f) => f.depositionId === l.depositionId && f.lineIds.some((id) => l.lineIds.includes(id)) && (!l.dimension || f.factualDimension === l.dimension)) }));
  return { labelled: labels.length, found: hits.filter((h) => h.found).length, recall: labels.length ? hits.filter((h) => h.found).length / labels.length : null, missed: hits.filter((h) => !h.found).map((h) => h.id) };
}

// How comparable two independently extracted facts are, for Stage 3 to find them together: the same
// attribute key, how much their answer-independent questions share, and the entities both name. Values
// are compared separately: compatible facts with different values are what Stage 3 looks for. Pure.
const jaccard = (a: string[], b: string[]) => { const x = new Set(a); const y = new Set(b); const n = [...x].filter((w) => y.has(w)).length; return x.size + y.size === n ? 0 : n / (x.size + y.size - n); };
export const QUESTION_OVERLAP_COMPATIBLE = 0.3;
type Comparable = { factualDimension: string | null; factualQuestion: string | null; subject: string | null; entities?: string[]; object: string | null; polarity: string | null };
export function compatibility(a: Comparable, b: Comparable) {
  const questionOverlap = jaccard(contentTokens(a.factualQuestion ?? ""), contentTokens(b.factualQuestion ?? ""));
  const entityOverlap = jaccard([a.subject ?? "", ...(a.entities ?? [])].flatMap(contentTokens), [b.subject ?? "", ...(b.entities ?? [])].flatMap(contentTokens));
  const sameKey = !!a.factualDimension && a.factualDimension === b.factualDimension;
  return { sameKey, questionOverlap: Math.round(questionOverlap * 100) / 100, entityOverlap: Math.round(entityOverlap * 100) / 100, compatible: sameKey || questionOverlap >= QUESTION_OVERLAP_COMPATIBLE, valuesDiffer: (a.object ?? "") !== (b.object ?? "") || a.polarity !== b.polarity };
}

