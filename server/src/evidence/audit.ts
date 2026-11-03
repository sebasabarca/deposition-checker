// Stage 1 integrity audits: why exchanges aren't verified, which stored documents carry artifacts a later
// parser revision fixed, and re-reading one document in place. Re-reading is a dry run unless asked, and
// refuses when it would remove findings a person may rely on, unless that impact is accepted.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { analyses, candidates, depositions, exchangeLines, exchanges, findings, lineSegments, lines, witnesses } from "../db/schema";
import { PARSER_VERSION, readDeposition, saveDeposition, type DepositionRead } from "../ingest";
import { speakerSegments } from "../ingest/segments";
import { inWindow, lineIdsByPosition, toExchangeLineRows, toExchangeRows, toLineRows, toSegmentRows } from "../ingest/rows";
import { readUpload } from "../ingest/uploads";
import type { Validation } from "../ingest/validate";
import { piecesOf, speakerStatusOf, type MemberLine, type SpeakerStatus } from "./exchange";
import { formatRef, schemeOf, sourceLineId } from "./references";

export type AttributionCause =
  | "no_testimony" // only attorney, counsel or record lines: nothing the witness said
  | "front_or_back_matter" // unattributed text before the first answer or after the last (cover, appearances, signature page)
  | "redacted_speaker" // a speaker label blacked out ("P| ...", a lone "a")
  | "possible_ocr_marker" // a garbled Q/A marker ("Qs ...")
  | "unrecognized_label" // a capitalized label naming nobody the reader knows
  | "note_left_unknown" // a whole-line [note] or (note) read as speech (fixed in revision 9)
  | "answer_attributed_to_other" // an answer line read as someone else's
  | "other_unattributed";

const REDACTED = /^(?:[A-Za-z]{0,3}[|\]=~_«»]+|.{1,2}$|[A-Z]{1,2}\s+(?=[A-Z«]))/;
const OCR_MARKER = /^(?:Qs|As|Q[,;']|A[,;'])(?:\s|$)/;
const LABEL = /^[A-Z][A-Z.'-]*(?: [A-Z][A-Z.'-]*)*:/;
const NOTE = /^(?:\[[^\]]*\]|\([^)]*\))$/;

type Exchange = { kind: string; members: MemberLine[] };
export type AttributionReport = {
  qa: number;
  counts: Record<SpeakerStatus, number>;
  causes: Partial<Record<AttributionCause, number>>;
  cases: { firstRef: string; status: SpeakerStatus; cause: AttributionCause; sample: string }[]; // the non-verified ones, in order
};

function causeOf(e: Exchange, status: SpeakerStatus, beforeFirst: boolean, afterLast: boolean): AttributionCause {
  const unknownLines = e.members.filter((m) => m.speakerRole === "unknown" || m.lineRole === "unknown");
  if (status === "invalid") return piecesOf(e.members).some((p) => p.answer && !p.segmented) ? "answer_attributed_to_other" : "no_testimony";
  if (unknownLines.some((m) => NOTE.test(m.text.trim()))) return "note_left_unknown";
  if (unknownLines.length && (beforeFirst || afterLast) && !e.members.some((m) => m.speakerRole === "witness")) return "front_or_back_matter";
  if (unknownLines.some((m) => OCR_MARKER.test(m.text.trim()))) return "possible_ocr_marker";
  if (unknownLines.some((m) => REDACTED.test(m.text.trim()))) return "redacted_speaker";
  if (unknownLines.some((m) => LABEL.test(m.text.trim()))) return "unrecognized_label";
  return "other_unattributed";
}

// Pure. The Q/A exchanges of one document, in order, with their members.
export function attributionReport(exchangesInOrder: readonly Exchange[], scheme: ReturnType<typeof schemeOf>): AttributionReport {
  const qa = exchangesInOrder.filter((e) => e.kind === "qa");
  const statuses = qa.map((e) => speakerStatusOf(e.kind, e.members).status);
  const first = statuses.indexOf("verified");
  const last = statuses.lastIndexOf("verified");
  const report: AttributionReport = { qa: qa.length, counts: { verified: 0, uncertain: 0, invalid: 0 }, causes: {}, cases: [] };
  qa.forEach((e, i) => {
    const status = statuses[i];
    report.counts[status]++;
    if (status === "verified") return;
    const cause = causeOf(e, status, first === -1 || i < first, i > last);
    report.causes[cause] = (report.causes[cause] ?? 0) + 1;
    const m = [...e.members].sort((x, y) => x.page - y.page || x.line - y.line)[0];
    report.cases.push({ firstRef: formatRef(scheme, m.page, m.line), status, cause, sample: m.text.slice(0, 60) });
  });
  return report;
}

// A stored document's exchanges, as members, in order.
async function storedExchanges(db: Database, documentId: number): Promise<Exchange[]> {
  const rows = await db.select({ id: exchanges.id, kind: exchanges.kind }).from(exchanges).where(eq(exchanges.depositionId, documentId)).orderBy(asc(exchanges.groupId), asc(exchanges.partNo));
  const members = rows.length ? await db.select({ exchangeId: exchangeLines.exchangeId, role: exchangeLines.role, from: exchangeLines.segmentFrom, to: exchangeLines.segmentTo, l: lines }).from(exchangeLines).innerJoin(lines, eq(lines.id, exchangeLines.lineId)).where(inArray(exchangeLines.exchangeId, rows.map((r) => r.id))).orderBy(asc(lines.printedPage), asc(lines.lineNo)) : [];
  const segs = members.length ? await db.select().from(lineSegments).where(inArray(lineSegments.lineId, members.map((m) => m.l.id))).orderBy(asc(lineSegments.seq)) : [];
  return rows.map((r) => ({
    kind: r.kind,
    members: members.filter((m) => m.exchangeId === r.id).map((m) => ({ page: m.l.printedPage, line: m.l.lineNo, text: m.l.rawText, lineRole: m.role, speakerRole: m.l.speakerRole, segments: inWindow(segs.filter((s) => s.lineId === m.l.id), m.from === null || m.to === null ? null : { from: m.from, to: m.to }).map((s) => ({ role: s.speakerRole, start: s.startOffset, end: s.endOffset })) })),
  }));
}

// A fresh read's exchanges, as members, in order (nothing stored).
function readExchanges(read: DepositionRead): Exchange[] {
  const lines = read.exchanges?.lines ?? [];
  return (read.exchanges?.parts ?? []).map((p) => ({ kind: p.kind, members: p.lines.map((m) => { const l = lines[m.index]; return { page: l.printedPage ?? 0, line: l.lineNo, text: l.rawText, lineRole: m.role, speakerRole: l.role, segments: inWindow(l.segments ?? [], m.segments).map((s) => ({ role: s.role, start: s.start, end: s.end })) }; }) }));
}

export async function storedAttribution(db: Database, documentId: number) {
  const [d] = await db.select({ validation: depositions.validation }).from(depositions).where(eq(depositions.id, documentId));
  return attributionReport(await storedExchanges(db, documentId), schemeOf((d?.validation as Validation | null)?.layout));
}

// What a document needs before its evidence can be trusted under the current parser: artifacts found in
// its stored rows (no file is read), and what re-reading it would touch.
export async function parserAudit(db: Database, scope: { caseId?: number } = {}) {
  const docs = await db.select({ id: depositions.id, caseId: depositions.caseId, parserVersion: depositions.parserVersion, validation: depositions.validation, status: depositions.status, storageKey: depositions.storageKey, excludedReason: depositions.excludedReason, duplicateOf: depositions.duplicateOf, witness: witnesses.name }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(scope.caseId === undefined ? undefined : eq(depositions.caseId, scope.caseId)).orderBy(asc(depositions.id));
  const out = [];
  for (const d of docs) {
    const layout = (d.validation as Validation | null)?.layout ?? null;
    const archive = layout === "text-archive-lines-v1";
    const count = async (where: ReturnType<typeof sql>) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from lines l where l.deposition_id = ${d.id} and ${where}`)).rows[0].n;
    const artifacts = {
      // Revision 8: an empty statement's number appended to the statement before it.
      strayStatementNumber: archive ? await count(sql`l.raw_text ~ (' ' || (l.line_no + 1)::text || '$') and not exists (select 1 from lines n where n.deposition_id = l.deposition_id and n.printed_page = l.printed_page and n.line_no = l.line_no + 1)`) : 0,
      // Revision 9: a whole-line note read as speech.
      noteReadAsSpeech: await count(sql`l.raw_text ~ '^(\\[[^]]*\\]|\\([^)]*\\))$' and l.speaker_role <> 'parenthetical'`),
      // Revision 9: an archive's named speaker left unknown.
      namedSpeakerUnknown: archive ? await count(sql`l.speaker_role = 'unknown' and l.raw_text ~ '^[A-Z][A-Z.''-]*( [A-Z][A-Z.''-]*)*:'`) : 0,
      // Revision 9: an archive statement holding several turns, stored without its segments.
      unsegmentedTurns: 0,
    };
    if (archive) {
      const rows = await db.select({ id: lines.id, text: lines.rawText }).from(lines).where(eq(lines.depositionId, d.id));
      const segmented = new Set((await db.selectDistinct({ id: lineSegments.lineId }).from(lineSegments).where(eq(lineSegments.depositionId, d.id))).map((r) => r.id));
      artifacts.unsegmentedTurns = rows.filter((r) => !segmented.has(r.id) && speakerSegments(r.text).length > 1).length;
    }
    const impact = await reprocessImpact(db, d.id);
    const found = Object.values(artifacts).reduce((n, v) => n + v, 0);
    out.push({
      documentId: d.id, caseId: d.caseId, witness: d.witness, layout, status: d.status, parserVersion: d.parserVersion, current: d.parserVersion === PARSER_VERSION, storedFile: !d.storageKey.startsWith("fixtures/"),
      artifacts, impact,
      excluded: d.excludedReason, duplicateOf: d.duplicateOf,
      action: d.excludedReason === "legacy_parse" ? "excluded: legacy parse, kept unchanged with its findings" : d.excludedReason === "duplicate" ? `excluded: duplicate of document ${d.duplicateOf}` : d.parserVersion === PARSER_VERSION ? "current" : found === 0 ? "older parser, no known artifact in its stored rows" : impact.findings > 0 ? "re-read needed; it would remove findings: needs approval" : "re-read needed; no findings affected",
    });
  }
  return out;
}

// What re-reading a document would remove: analyses compare it, and their candidates and findings point at
// its exchanges, which a re-read replaces (the foreign keys cascade).
export async function reprocessImpact(db: Database, documentId: number) {
  const analysisRows = await db.select({ id: analyses.id }).from(analyses).where(or(eq(analyses.depositionA, documentId), eq(analyses.depositionB, documentId)));
  const cand = await db.select({ id: candidates.id }).from(candidates).where(or(eq(candidates.depositionA, documentId), eq(candidates.depositionB, documentId)));
  const found = cand.length ? await db.select({ id: findings.id, reviewState: findings.reviewState }).from(findings).where(inArray(findings.candidateId, cand.map((c) => c.id))) : [];
  return { analyses: analysisRows.map((a) => a.id), candidates: cand.length, findings: found.length, reviewedFindings: found.filter((f) => f.reviewState !== "unreviewed").length };
}

type ReprocessOptions = { execute?: boolean; acceptImpact?: boolean; uploadsDir?: string; read?: (data: Uint8Array, witness: string) => Promise<DepositionRead> };

// Re-reads one stored document with the current parser. The dry run (default) changes nothing and reports
// the source lines whose text, speaker or presence would change, the attribution before and after, and the
// impact. Executing replaces its lines and exchanges in place: same document, case, witness and session.
export async function reprocessDocument(db: Database, documentId: number, opts: ReprocessOptions = {}) {
  const [d] = await db.select({ d: depositions, witness: witnesses.name }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(eq(depositions.id, documentId));
  if (!d) throw new Error(`No document ${documentId}.`);
  const doc = d.d;
  const data = await readUpload(doc.storageKey, opts.uploadsDir).catch(() => null);
  if (!data) return { documentId, outcome: "stored_file_missing" as const, detail: `The stored file ${doc.storageKey} isn't available, so the document can't be re-read; its evidence is kept as it is.` };
  const read = await (opts.read ?? ((bytes, witness) => readDeposition(bytes, undefined, undefined, witness)))(data, d.witness);
  if (read.validation.status !== "ready" || !read.exchanges) return { documentId, outcome: "reread_not_ready" as const, detail: `The re-read is ${read.validation.status}; the stored evidence is kept.` };
  const scheme = schemeOf(read.validation.layout);
  const old = await db.select().from(lines).where(eq(lines.depositionId, documentId));
  const key = (page: number, line: number) => `${page}:${line}`;
  const before = new Map(old.map((l) => [key(l.printedPage, l.lineNo), l]));
  const after = new Map(read.exchanges.lines.map((l) => [key(l.printedPage ?? 0, l.lineNo), l]));
  const id = (k: string) => { const [p, l] = k.split(":").map(Number); return sourceLineId(doc.fileSha256, p, l); };
  const changes = {
    textChanged: [...before.keys()].filter((k) => after.has(k) && after.get(k)!.rawText !== before.get(k)!.rawText).map(id),
    speakerChanged: [...before.keys()].filter((k) => after.has(k) && after.get(k)!.role !== before.get(k)!.speakerRole).map(id),
    removed: [...before.keys()].filter((k) => !after.has(k)).map(id),
    added: [...after.keys()].filter((k) => !before.has(k)).map(id),
    segmented: read.exchanges.lines.filter((l) => l.segments?.length).map((l) => sourceLineId(doc.fileSha256, l.printedPage ?? 0, l.lineNo)),
  };
  const oldKeys = new Set((await db.select({ k: exchanges.evidenceKey }).from(exchanges).where(eq(exchanges.depositionId, documentId))).map((r) => r.k));
  const report = {
    documentId, fromParser: doc.parserVersion, toParser: read.parserVersion,
    lines: { before: old.length, after: read.exchanges.lines.length },
    changes,
    attribution: { before: await storedAttribution(db, documentId), after: attributionReport(readExchanges(read), scheme) },
    impact: await reprocessImpact(db, documentId),
  };
  if (!opts.execute) return { ...report, outcome: "dry_run" as const };
  if (report.impact.findings > 0 && !opts.acceptImpact) return { ...report, outcome: "refused" as const, detail: `Re-reading would remove ${report.impact.findings} findings (${report.impact.reviewedFindings} reviewed) of analyses ${report.impact.analyses.join(", ")}. Nothing was changed; pass --accept-impact to proceed.` };
  const saved = await saveDeposition(db, { caseId: doc.caseId, witnessId: doc.witnessId, takenOn: doc.takenOn, fileSha256: doc.fileSha256, storageKey: doc.storageKey, read, reprocessOf: documentId });
  if (!("depositionId" in saved) || saved.depositionId !== documentId) throw new Error("The re-read didn't replace the document in place.");
  const newKeys = new Set((await db.select({ k: exchanges.evidenceKey }).from(exchanges).where(eq(exchanges.depositionId, documentId))).map((r) => r.k));
  return { ...report, outcome: "reprocessed" as const, exchangeIds: { removed: [...oldKeys].filter((k) => !newKeys.has(k)), added: [...newKeys].filter((k) => !oldKeys.has(k)), kept: [...newKeys].filter((k) => oldKeys.has(k)).length } };
}


// Correcting a document in place. A parser revision that changes only who said what (speaker roles,
// notes, segments) leaves every line's text and position as they were. Then the document can be
// corrected without removing anything a person or a model relied on: every line keeps its ID, and every
// exchange whose lines stay the same keeps its ID (its roles, texts and status are recomputed), so the
// candidates, cards, verdicts and findings on it stay attached. An exchange whose lines change is
// replaced only when nothing refers to it. Otherwise nothing is changed: the dry run maps each such
// exchange to the corrected exchanges sharing its lines and lists the findings that would need review.

type CorrectOptions = ReprocessOptions & { backupDir?: string };
type Referrers = { candidates: number; cards: number; coverage: number; claims: number; tagging: number };

// What refers to each of these exchanges, by exchange row ID.
async function referrersOf(db: Database, ids: number[]): Promise<Map<number, Referrers>> {
  const out = new Map<number, Referrers>(ids.map((id) => [id, { candidates: 0, cards: 0, coverage: 0, claims: 0, tagging: 0 }]));
  if (!ids.length) return out;
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const rows = await db.execute<{ id: string; k: keyof Referrers; n: number }>(sql`
    select id, k, count(*)::int as n from (
      select exchange_a as id, 'candidates' as k from candidates where exchange_a in (${list})
      union all select exchange_b, 'candidates' from candidates where exchange_b in (${list})
      union all select exchange_id, 'cards' from statement_cards where exchange_id in (${list})
      union all select exchange_id, 'coverage' from card_coverage where exchange_id in (${list})
      union all select exchange_id, 'claims' from claims where exchange_id in (${list})
      union all select exchange_id, 'tagging' from claim_tagging where exchange_id in (${list})
    ) r group by 1, 2`);
  for (const r of rows.rows) out.get(Number(r.id))![r.k] = r.n;
  return out;
}

// Every row derived from this document that must survive a correction, counted.
async function dependents(db: Database, documentId: number) {
  const [r] = (await db.execute<Record<string, number>>(sql`
    with c as (select id from candidates where deposition_a = ${documentId} or deposition_b = ${documentId})
    select (select count(*) from c)::int as candidates,
      (select count(*) from verdicts where candidate_id in (select id from c))::int as verdicts,
      (select count(*) from findings where candidate_id in (select id from c))::int as findings,
      (select count(*) from findings where candidate_id in (select id from c) and review_state <> 'unreviewed')::int as reviewed,
      (select count(*) from statement_cards where deposition_id = ${documentId})::int as cards,
      (select count(*) from card_coverage where deposition_id = ${documentId})::int as coverage,
      (select count(*) from claims where deposition_id = ${documentId})::int as claims,
      (select count(*) from lines where deposition_id = ${documentId})::int as lines`)).rows;
  return r;
}

export async function correctInPlace(db: Database, documentId: number, opts: CorrectOptions = {}) {
  const [d] = await db.select({ d: depositions, witness: witnesses.name }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(eq(depositions.id, documentId));
  if (!d) throw new Error(`No document ${documentId}.`);
  const doc = d.d;
  const data = await readUpload(doc.storageKey, opts.uploadsDir).catch(() => null);
  if (!data) return { documentId, outcome: "stored_file_missing" as const, detail: `The stored file ${doc.storageKey} isn't available; nothing was changed.` };
  const read = await (opts.read ?? ((bytes, witness) => readDeposition(bytes, undefined, undefined, witness)))(data, d.witness);
  if (read.validation.status !== "ready" || !read.exchanges) return { documentId, outcome: "reread_not_ready" as const, detail: `The re-read is ${read.validation.status}; nothing was changed.` };
  const { lines: attributed, parts } = read.exchanges;
  const scheme = schemeOf(read.validation.layout);
  const pos = (page: number, line: number) => `${page}:${line}`;

  // 1. Source lines: the same positions with the same text, or nothing can be done in place.
  const old = await db.select().from(lines).where(eq(lines.depositionId, documentId));
  const byPos = new Map(old.map((l) => [pos(l.printedPage, l.lineNo), l]));
  const fresh = toLineRows(documentId, attributed);
  const textMoved = fresh.filter((l) => byPos.get(pos(l.printedPage, l.lineNo))?.rawText !== l.rawText).length + Math.max(0, old.length - fresh.length);
  if (textMoved > 0) return { documentId, outcome: "not_in_place" as const, detail: `${textMoved} source lines would change text or position; correcting it needs a versioned migration. Nothing was changed.` };
  const lineIds = lineIdsByPosition(attributed, old);
  const changedLines = fresh.flatMap((l, i) => {
    const o = byPos.get(pos(l.printedPage, l.lineNo))!;
    const fields = ["speakerRole", "speakerName", "normText", "ocrText", "ocrConfidence", "pdfPage"] as const;
    const changed = fields.filter((f) => o[f] !== l[f]);
    return changed.length ? [{ id: lineIds[i], sourceId: sourceLineId(doc.fileSha256, l.printedPage, l.lineNo), changed, from: Object.fromEntries(changed.map((f) => [f, o[f]])), to: Object.fromEntries(changed.map((f) => [f, l[f]])) }] : [];
  });

  // 2. Exchanges, matched by their exact set of lines.
  const oldRows = await db.select().from(exchanges).where(eq(exchanges.depositionId, documentId));
  const oldMembers = oldRows.length ? await db.select().from(exchangeLines).where(inArray(exchangeLines.exchangeId, oldRows.map((r) => r.id))) : [];
  const sig = (ids: number[]) => [...ids].sort((a, b) => a - b).join(",");
  const oldSig = new Map(oldRows.map((r) => [r.id, sig(oldMembers.filter((m) => m.exchangeId === r.id).map((m) => m.lineId))]));
  const newSig = parts.map((p) => sig(p.lines.map((m) => lineIds[m.index])));
  if (new Set(newSig).size !== newSig.length || new Set(oldSig.values()).size !== oldSig.size) return { documentId, outcome: "not_in_place" as const, detail: "Two exchanges share the same lines, so they can't be matched one to one. Nothing was changed." };
  const partBySig = new Map(newSig.map((s, i) => [s, i]));
  const matched = new Map<number, number>(); // old exchange row ID -> new part index
  for (const [id, s] of oldSig) if (partBySig.has(s)) matched.set(id, partBySig.get(s)!);
  const taken = new Set(matched.values());
  const removed = oldRows.filter((r) => !matched.has(r.id));
  const added = parts.map((_, i) => i).filter((i) => !taken.has(i));
  const refs = await referrersOf(db, removed.map((r) => r.id));
  const referenced = removed.filter((r) => Object.values(refs.get(r.id)!).some((n) => n > 0));

  const rows = toExchangeRows(documentId, doc.witnessId, parts, lineIds, { fileSha256: doc.fileSha256, lines: attributed });
  const ref = (lineId: number) => { const l = old.find((x) => x.id === lineId)!; return formatRef(scheme, l.printedPage, l.lineNo); };
  const statusChanged = oldRows.filter((r) => matched.has(r.id) && r.speakerStatus !== rows[matched.get(r.id)!].speakerStatus).map((r) => ({ exchangeRowId: r.id, id: r.evidenceKey, from: r.speakerStatus, to: rows[matched.get(r.id)!].speakerStatus }));

  // 3. Findings on this document, and whether each would carry over unchanged.
  const cands = await db.select({ id: candidates.id, a: candidates.exchangeA, b: candidates.exchangeB }).from(candidates).where(or(eq(candidates.depositionA, documentId), eq(candidates.depositionB, documentId)));
  const found = cands.length ? await db.select({ id: findings.id, candidateId: findings.candidateId, reviewState: findings.reviewState }).from(findings).where(inArray(findings.candidateId, cands.map((c) => c.id))) : [];
  const mine = new Set(oldRows.map((r) => r.id));
  const changedStatus = new Map(statusChanged.map((s) => [s.exchangeRowId, s]));
  const findingCheck = found.map((f) => {
    const c = cands.find((x) => x.id === f.candidateId)!;
    const sides = [c.a, c.b].filter((x) => mine.has(x));
    const lost = sides.filter((x) => !matched.has(x));
    const restatus = sides.filter((x) => changedStatus.has(x)).map((x) => changedStatus.get(x)!);
    const verdict = lost.length ? "requires_review: its exchange's lines change" : restatus.length ? `requires_review: speaker status ${restatus.map((s) => `${s.from} -> ${s.to}`).join(", ")}` : "carries_over";
    return { findingId: f.id, reviewState: f.reviewState, verdict };
  });
  // Where each referenced exchange's lines go: the corrected exchanges sharing them (deterministic).
  const mapping = referenced.map((r) => {
    const mineLines = new Set(oldMembers.filter((m) => m.exchangeId === r.id).map((m) => m.lineId));
    const overlaps = parts.map((p, i) => ({ i, shared: p.lines.filter((m) => mineLines.has(lineIds[m.index])).length, size: p.lines.length })).filter((o) => o.shared > 0);
    return {
      exchangeRowId: r.id, id: r.evidenceKey, group: r.groupId, part: r.partNo, lines: mineLines.size, referrers: refs.get(r.id)!,
      to: overlaps.map((o) => ({ id: rows[o.i].evidenceKey, group: parts[o.i].groupNo, part: parts[o.i].partNo, from: ref(lineIds[parts[o.i].span.first]), until: ref(lineIds[parts[o.i].span.last]), sharedLines: o.shared, relation: o.shared === mineLines.size ? (o.size > o.shared ? "contains it, with more lines" : "same lines") : "holds part of it" })),
    };
  });

  const before = await dependents(db, documentId);
  const report = {
    documentId, fromParser: doc.parserVersion, toParser: read.parserVersion,
    lines: { total: old.length, textChanged: 0, speakerChanged: changedLines.filter((l) => l.changed.includes("speakerRole")).length, otherFieldsChanged: changedLines.filter((l) => !l.changed.includes("speakerRole")).length },
    segments: { statements: attributed.filter((l) => l.segments?.length).length },
    exchanges: { before: oldRows.length, after: parts.length, keptWithSameId: matched.size, statusChanged: statusChanged.length, replacedUnreferenced: removed.length - referenced.length, referencedWouldChange: referenced.length, added: added.length },
    attribution: { before: (await storedAttribution(db, documentId)).counts, after: attributionReport(readExchanges(read), scheme).counts },
    dependents: before,
    findings: { total: findingCheck.length, carriesOver: findingCheck.filter((f) => f.verdict === "carries_over").length, requiresReview: findingCheck.filter((f) => f.verdict !== "carries_over") },
    statusChanged, mapping,
  };
  if (referenced.length) return { ...report, outcome: "needs_versioned_migration" as const, detail: `${referenced.length} exchanges that candidates, cards or findings refer to would change their lines, so they can't keep their IDs. Nothing was changed; see mapping.` };
  if (!opts.execute) return { ...report, outcome: "dry_run" as const };

  // Backup of everything the correction overwrites, written before anything changes.
  const segsBefore = await db.select().from(lineSegments).where(eq(lineSegments.depositionId, documentId));
  const candGroups = await db.select({ id: candidates.id, groupA: candidates.groupA, groupB: candidates.groupB }).from(candidates).where(or(eq(candidates.depositionA, documentId), eq(candidates.depositionB, documentId)));
  const backupDir = opts.backupDir ?? path.join("data", "raw", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `document-${documentId}-${doc.parserVersion}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, JSON.stringify({ document: { id: doc.id, parserVersion: doc.parserVersion, validation: doc.validation }, lines: changedLines.map((l) => ({ id: l.id, ...l.from })), lineSegments: segsBefore, exchanges: oldRows.map(({ tsv: _tsv, ...r }) => r), exchangeLines: oldMembers, candidateGroups: candGroups }, null, 1));

  await db.transaction(async (tx) => {
    const [clash] = await tx.select({ id: depositions.id }).from(depositions).where(and(eq(depositions.caseId, doc.caseId), eq(depositions.fileSha256, doc.fileSha256), eq(depositions.parserVersion, read.parserVersion)));
    if (clash && clash.id !== documentId) throw new Error(`Deposition ${clash.id} already holds this file under parser ${read.parserVersion}; nothing was changed.`);
    for (const l of changedLines) await tx.update(lines).set(l.to).where(eq(lines.id, l.id));
    await tx.delete(lineSegments).where(eq(lineSegments.depositionId, documentId));
    const segRows = toSegmentRows(documentId, attributed, lineIds);
    if (segRows.length) await tx.insert(lineSegments).values(segRows);
    if (removed.length) await tx.delete(exchanges).where(inArray(exchanges.id, removed.map((r) => r.id)));
    // Out of the way of (deposition, group, part) while groups are renumbered.
    await tx.execute(sql`update exchanges set group_id = -id where deposition_id = ${documentId}`);
    for (const [id, i] of matched) await tx.update(exchanges).set(rows[i]).where(eq(exchanges.id, id));
    const stored = [...matched].map(([id, i]) => ({ id, groupId: parts[i].groupNo, partNo: parts[i].partNo }));
    if (added.length) stored.push(...(await tx.insert(exchanges).values(added.map((i) => rows[i])).returning({ id: exchanges.id, groupId: exchanges.groupId, partNo: exchanges.partNo })));
    if (matched.size) await tx.delete(exchangeLines).where(inArray(exchangeLines.exchangeId, [...matched.keys()]));
    const memberRows = toExchangeLineRows(documentId, parts, stored, lineIds);
    for (let i = 0; i < memberRows.length; i += 2000) await tx.insert(exchangeLines).values(memberRows.slice(i, i + 2000));
    // Candidates name their exchanges' groups too.
    await tx.execute(sql`update candidates c set group_a = e.group_id from exchanges e where e.id = c.exchange_a and c.deposition_a = ${documentId} and c.group_a <> e.group_id`);
    await tx.execute(sql`update candidates c set group_b = e.group_id from exchanges e where e.id = c.exchange_b and c.deposition_b = ${documentId} and c.group_b <> e.group_id`);
    await tx.update(depositions).set({ parserVersion: read.parserVersion, validation: read.validation }).where(eq(depositions.id, documentId));
    const after = await dependents(tx as unknown as Database, documentId);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`The correction would change dependent rows (${JSON.stringify(before)} -> ${JSON.stringify(after)}); nothing was changed.`);
  });
  return { ...report, outcome: "corrected" as const, backup };
}
