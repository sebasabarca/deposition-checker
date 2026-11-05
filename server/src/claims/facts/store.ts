// Stage 2 persistence: unit coverage rows kept in step with the stored evidence, fact rows, and the
// read interface Stage 3 uses. Nothing here deletes transcript evidence; a unit whose source spans
// changed has its facts marked stale, never left current.

import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { depositions, factUnits, facts, lines } from "../../db/schema";
import { formatRef, schemeOf } from "../../evidence/references";
import type { Validation } from "../../ingest/validate";
import { FACT_EXTRACTOR_VERSION, type AttributionStatus } from "./contracts";
import { buildUnits, loadDocument, type Unit } from "./context";
import type { CheckedFact } from "./verify";

// suspected_omission isn't due: a normal run doesn't pay to ask again; it is counted and reported.
export type UnitStatus = "pending" | "extracted" | "empty" | "suspected_omission" | "no_testimony" | "omitted" | "failed" | "incomplete";
// Units a run sends: never processed, or processed without a usable answer.
export const DUE: UnitStatus[] = ["pending", "failed", "omitted"];

const initialStatus = (u: Unit): { status: UnitStatus; error: string | null } =>
  u.oversized ? { status: "incomplete", error: u.oversized } : !u.testimony ? { status: "no_testimony", error: null } : { status: "pending", error: null };

// Brings a document's unit rows in line with its stored evidence: new units are added; a unit whose
// source spans changed (a re-read, a corrected speaker) is reset and its facts marked stale; units that
// no longer exist (exchange boundaries moved) are removed from coverage and their facts marked stale.
// With write false it only reports what it would do: the statuses units would have, and how many are stale.
export async function syncUnits(db: Database, documentId: number, extractorVersion = FACT_EXTRACTOR_VERSION, write = true) {
  const doc = await loadDocument(db, documentId);
  if (doc.status !== "ready") throw new Error(`Document ${documentId} is ${doc.status}; only ready documents have facts.`);
  if (doc.excludedReason) throw new Error(`Document ${documentId} is excluded (${doc.excludedReason}); it is never extracted.`);
  const units = buildUnits(doc);
  const stored = new Map((await db.select().from(factUnits).where(and(eq(factUnits.depositionId, documentId), eq(factUnits.extractorVersion, extractorVersion)))).map((r) => [r.unitKey, r]));
  const changed = units.filter((u) => stored.has(u.unitKey) && stored.get(u.unitKey)!.sourceHash !== u.sourceHash);
  const gone = [...stored.keys()].filter((k) => !units.some((u) => u.unitKey === k));
  if (!write) {
    const status = new Map(units.map((u) => [u.unitKey, stored.has(u.unitKey) && !changed.includes(u) ? (stored.get(u.unitKey)!.status as UnitStatus) : initialStatus(u).status]));
    return { doc, units, status, staleUnits: changed.length + gone.length };
  }
  let staleUnits = 0;
  let rekeyed = 0;
  await db.transaction(async (tx) => {
    const stale = async (keys: string[]) => {
      if (!keys.length) return;
      staleUnits += keys.length;
      await tx.update(facts).set({ status: "stale" }).where(and(inArray(facts.unitKey, keys), eq(facts.extractorVersion, extractorVersion), eq(facts.status, "indexed")));
    };
    await stale(changed.map((u) => u.unitKey));
    await stale(gone);
    if (gone.length) await tx.delete(factUnits).where(and(inArray(factUnits.unitKey, gone), eq(factUnits.extractorVersion, extractorVersion)));
    const rows = units.filter((u) => !stored.has(u.unitKey) || changed.includes(u)).map((u) => ({
      unitKey: u.unitKey, extractorVersion, caseId: u.caseId, witnessId: u.witnessId, depositionId: u.depositionId, groupId: u.groupId, windowNo: u.windowNo, windowCount: u.windowCount,
      exchangeIds: u.exchangeIds, sourceHash: u.sourceHash, parserVersion: doc.parserVersion, ...initialStatus(u), facts: 0, rejected: 0, duplicates: 0, llmCallId: null, updatedAt: new Date(),
    }));
    // A unit whose source is the same (same key, which is its first and last source position, and same source
    // hash, which covers every span's text, speaker and role) keeps its status and facts, but follows the
    // exchanges it is read from: a correction that splits an exchange renumbers the groups after it.
    const moved = units.filter((u) => {
      const r = stored.get(u.unitKey);
      return r && r.sourceHash === u.sourceHash && (r.groupId !== u.groupId || r.windowNo !== u.windowNo || r.windowCount !== u.windowCount || r.exchangeIds.join() !== u.exchangeIds.join());
    });
    for (const u of moved) {
      await tx.update(factUnits).set({ groupId: u.groupId, windowNo: u.windowNo, windowCount: u.windowCount, exchangeIds: u.exchangeIds }).where(and(eq(factUnits.unitKey, u.unitKey), eq(factUnits.extractorVersion, extractorVersion)));
    }
    rekeyed = moved.length;
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(factUnits).values(rows.slice(i, i + 500)).onConflictDoUpdate({
        target: [factUnits.unitKey, factUnits.extractorVersion],
        set: { sourceHash: sql`excluded.source_hash`, parserVersion: sql`excluded.parser_version`, status: sql`excluded.status`, error: sql`excluded.error`, exchangeIds: sql`excluded.exchange_ids`, groupId: sql`excluded.group_id`, windowNo: sql`excluded.window_no`, windowCount: sql`excluded.window_count`, facts: 0, rejected: 0, duplicates: 0, llmCallId: null, updatedAt: new Date() },
      });
    }
  });
  const status = new Map((await db.select({ key: factUnits.unitKey, status: factUnits.status }).from(factUnits).where(and(eq(factUnits.depositionId, documentId), eq(factUnits.extractorVersion, extractorVersion)))).map((r) => [r.key, r.status as UnitStatus]));
  return { doc, units, status, staleUnits, rekeyed };
}

export const factRow = (c: CheckedFact, llmCallId: number | null, extractorVersion = FACT_EXTRACTOR_VERSION) => ({
  factKey: c.factKey, unitKey: c.unitKey, extractorVersion, caseId: c.caseId, witnessId: c.witnessId, depositionId: c.depositionId,
  exchangeId: c.spans[0]?.exchangeId ?? null, sourceSpanIds: c.spans.map((s) => s.sourceSpanId), contextSpanIds: c.contextSpans.map((s) => s.sourceSpanId), lineIds: [...new Set(c.spans.map((s) => s.lineId))],
  kind: c.kind, subject: c.fact?.subject ?? null, entities: c.fact?.entities ?? [], predicate: c.fact?.predicate ?? null, attribute: c.fact?.attribute ?? null, object: c.fact?.value ?? null, valuePhrase: c.fact?.valuePhrase ?? null,
  factualQuestion: c.fact?.factualQuestion ?? null, factualDimension: c.dimension,
  polarity: c.fact?.polarity ?? null, epistemicStatus: c.fact?.epistemicStatus ?? null, reportedSpeaker: c.fact?.reportedSpeaker ?? null, hedges: c.hedges, correction: c.fact?.correction ?? null,
  timeContext: c.fact?.timeScope ?? null, locationContext: c.fact?.locationScope ?? null, event: c.event, eventHints: c.fact?.event.anchors ?? [], evidencePhrase: c.fact?.evidencePhrase ?? null,
  provenance: c.provenance, attributionStatus: c.attributionStatus, sourceVerification: c.sourceVerification, valueSupport: c.valueSupport, semanticStatus: c.semanticStatus, reviewReasons: c.reviewReasons,
  status: c.status, rejectionReason: c.rejectionReason, warnings: c.warnings, sourceHash: c.sourceHash, raw: (c.raw ?? {}) as object, llmCallId,
});

export type FactFilter = { caseId: number; witnessId?: number; depositionId?: number; dimension?: string; attribution?: AttributionStatus[]; extractorVersion?: string };
export type SourceLine = { lineId: number; ref: string; text: string }; // stored text, never the model's

// Stage 3's entry point: the verified index. Indexed facts of active documents only (never excluded
// copies or stale facts), each with the stored source lines it rests on.
export async function verifiedFacts(db: Database, f: FactFilter) {
  const rows = await db
    .select({ fact: facts, validation: depositions.validation })
    .from(facts)
    .innerJoin(depositions, eq(depositions.id, facts.depositionId))
    .where(and(
      eq(facts.caseId, f.caseId), eq(facts.status, "indexed"), eq(facts.extractorVersion, f.extractorVersion ?? FACT_EXTRACTOR_VERSION), isNull(depositions.excludedReason),
      inArray(facts.attributionStatus, f.attribution ?? ["verified", "uncertain"]),
      f.witnessId === undefined ? undefined : eq(facts.witnessId, f.witnessId),
      f.depositionId === undefined ? undefined : eq(facts.depositionId, f.depositionId),
      f.dimension === undefined ? undefined : eq(facts.factualDimension, f.dimension),
    ))
    .orderBy(asc(facts.depositionId), asc(facts.id));
  const lineIds = [...new Set(rows.flatMap((r) => r.fact.lineIds))];
  const stored = lineIds.length ? await db.select({ id: lines.id, page: lines.printedPage, line: lines.lineNo, text: lines.rawText }).from(lines).where(inArray(lines.id, lineIds)) : [];
  const byId = new Map(stored.map((l) => [l.id, l]));
  return rows.map(({ fact, validation }) => {
    const scheme = schemeOf((validation as Validation | null)?.layout);
    return { ...fact, sourceLines: fact.lineIds.map((id): SourceLine => { const l = byId.get(id)!; return { lineId: id, ref: formatRef(scheme, l.page, l.line), text: l.text }; }) };
  });
}
export type VerifiedFact = Awaited<ReturnType<typeof verifiedFacts>>[number];

// Keys of a document's stored facts, so a retry recognizes what it already has.
export async function storedFactKeys(db: Database, documentId: number, extractorVersion = FACT_EXTRACTOR_VERSION) {
  return new Set((await db.select({ k: facts.factKey }).from(facts).where(and(eq(facts.depositionId, documentId), eq(facts.extractorVersion, extractorVersion), notInArray(facts.status, ["stale"])))).map((r) => r.k));
}
