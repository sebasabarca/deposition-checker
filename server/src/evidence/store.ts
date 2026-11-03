// The Stage 1 evidence index over stored testimony: every Q/A exchange retrievable by a stable ID,
// searchable by its original words (Postgres full-text search on exchanges.tsv, no model involved),
// with its source lines, their references in the transcript's own scheme, and the context around it.
// Reads only, apart from indexEvidence(), which fills the evidence fields of exchanges stored before them.

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import { depositionSessions, depositions, exchangeLines, exchanges, lineSegments, lines, witnesses } from "../db/schema";
import { inWindow } from "../ingest/rows";
import type { Validation } from "../ingest/validate";
import { sessionCoverage } from "../verify";
import { evidenceFieldsOf, piecesOf, speakerStatusOf, textHashOf, type MemberLine, type MemberSegment, type SpeakerStatus } from "./exchange";
import { formatRef, isCitable, schemeOf, sourceLineId, type ReferenceScheme } from "./references";

export type SourceRef = {
  sourceId: string; // stable: the file and stored position (references.ts)
  lineRowId: number; // the current database row; changes when the file is read again
  documentId: number;
  scheme: ReferenceScheme;
  ref: string; // in the transcript's own scheme: "6:04", "statement 494", "line 12"
  citable: boolean; // a printed page:line, as a court reporter's transcript has it
  pageInferred: boolean; // the page number was inferred by the reader, not printed
  text: string; // the stored source text, verbatim
  speaker: string; // the reader's attribution: witness, attorney, colloquy, parenthetical or unknown
  speakerName: string | null;
  lineRole: string; // in this exchange: question, answer, context or unknown
  ocrConfidence: number | null; // for a line read from a scan
  // Where the line holds more than one turn: each speaker's part, as character ranges of `text` (which
  // stays whole), all under this line's one reference. Null for a line with one speaker.
  segments: { start: number; end: number; speaker: string; speakerName: string | null; text: string }[] | null;
};

export type EvidenceExchange = {
  id: string | null; // the stable evidence key; null until the exchange is indexed
  rowId: number;
  caseId: number;
  witnessId: number;
  witness: string;
  sessionId: number;
  sessionPart: number; // the file's place in its session
  documentId: number; // the uploaded file (a `depositions` row)
  documentSha256: string;
  takenOn: string | null;
  kind: string;
  flags: string[]; // starts_mid_turn, ends_at_gap, no_answer, no_question
  // A long answer is split into overlapping parts of one group (ingest/exchanges.ts); each later part repeats
  // the question. sharedWithPrevious and sharedWithNext count the lines this part shares with its neighbours.
  part: { groupId: number; partNo: number; partCount: number; sharedWithPrevious: number; sharedWithNext: number };
  question: string; // what the attorneys said: question lines and attorney segments, verbatim, one per line
  answer: string; // what the witness said: answer lines and witness segments, verbatim
  sourceStart: SourceRef;
  sourceEnd: SourceRef;
  lines: SourceRef[];
  speakerStatus: SpeakerStatus | null; // as indexed
  speakerReasons: string[];
  textHash: string | null; // as indexed
  // Recomputed now from the stored lines: false means the evidence changed since it was indexed.
  integrity: { textHashMatches: boolean | null; speakerStatusMatches: boolean | null };
};

const docColumns = { id: depositions.id, caseId: depositions.caseId, witnessId: depositions.witnessId, sessionId: depositions.sessionId, sessionPart: depositions.sessionPart, sha: depositions.fileSha256, takenOn: depositions.takenOn, validation: depositions.validation, witness: witnesses.name };
type Doc = { id: number; caseId: number; witnessId: number; sessionId: number; sessionPart: number; sha: string; takenOn: string | null; validation: Validation | null; witness: string };
type LineRow = typeof lines.$inferSelect;
type SegmentRow = typeof lineSegments.$inferSelect;

// The segments of these lines, by line ID, in order.
async function segmentsOf(db: Database, lineIds: readonly number[]) {
  const rows = lineIds.length ? await db.select().from(lineSegments).where(inArray(lineSegments.lineId, [...lineIds])).orderBy(asc(lineSegments.lineId), asc(lineSegments.seq)) : [];
  const by = new Map<number, SegmentRow[]>();
  for (const r of rows) by.set(r.lineId, [...(by.get(r.lineId) ?? []), r]);
  return by;
}

// segments: those of the line in this exchange (inWindow), for a line holding several turns.
function sourceRef(doc: Doc, l: LineRow, lineRole: string, segments?: SegmentRow[]): SourceRef {
  const scheme = schemeOf(doc.validation?.layout);
  const inferred = new Set(doc.validation?.ocr?.inferredPages ?? doc.validation?.inferredPages ?? []);
  return { sourceId: sourceLineId(doc.sha, l.printedPage, l.lineNo), lineRowId: l.id, documentId: doc.id, scheme, ref: formatRef(scheme, l.printedPage, l.lineNo), citable: isCitable(scheme), pageInferred: inferred.has(l.pdfPage), text: l.rawText, speaker: l.speakerRole, speakerName: l.speakerName, lineRole, ocrConfidence: l.ocrConfidence, segments: segments?.length ? segments.map((x) => ({ start: x.startOffset, end: x.endOffset, speaker: x.speakerRole, speakerName: x.speakerName, text: l.rawText.slice(x.startOffset, x.endOffset) })) : null };
}

type Window = { from: number | null; to: number | null };
const windowOf = (m: Window) => (m.from === null || m.to === null ? null : { from: m.from, to: m.to });
const member = (l: LineRow, lineRole: string, segments?: SegmentRow[]): MemberLine => ({ page: l.printedPage, line: l.lineNo, text: l.rawText, lineRole, speakerRole: l.speakerRole, segments: segments?.map((x): MemberSegment => ({ role: x.speakerRole, start: x.startOffset, end: x.endOffset })) });

// Full records for exchange rows, in the order given.
async function hydrate(db: Database, rowIds: readonly number[]): Promise<EvidenceExchange[]> {
  if (rowIds.length === 0) return [];
  const rows = await db.select({ e: exchanges, d: docColumns }).from(exchanges).innerJoin(depositions, eq(depositions.id, exchanges.depositionId)).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(inArray(exchanges.id, [...rowIds]));
  const members = await db.select({ exchangeId: exchangeLines.exchangeId, role: exchangeLines.role, from: exchangeLines.segmentFrom, to: exchangeLines.segmentTo, l: lines }).from(exchangeLines).innerJoin(lines, eq(lines.id, exchangeLines.lineId)).where(inArray(exchangeLines.exchangeId, [...rowIds])).orderBy(asc(lines.printedPage), asc(lines.lineNo));
  const segs = await segmentsOf(db, members.map((m) => m.l.id));
  // The lines of every part of these exchanges' groups, to count what neighbouring parts share.
  const groups = [...new Set(rows.filter((r) => r.e.partCount > 1).map((r) => `${r.e.depositionId}/${r.e.groupId}`))];
  const siblings = groups.length ? await db.execute<{ deposition_id: string; group_id: number; part_no: number; line_id: string }>(sql`
    select e.deposition_id, e.group_id, e.part_no, el.line_id from exchanges e join exchange_lines el on el.exchange_id = e.id
    where (e.deposition_id::text || '/' || e.group_id::text) in (${sql.join(groups.map((g) => sql`${g}`), sql`, `)})`) : { rows: [] };
  const partLines = (dep: number, group: number, partNo: number) => new Set(siblings.rows.filter((r) => Number(r.deposition_id) === dep && r.group_id === group && r.part_no === partNo).map((r) => Number(r.line_id)));
  const shared = (dep: number, group: number, a: number, b: number) => { const x = partLines(dep, group, a); return [...partLines(dep, group, b)].filter((id) => x.has(id)).length; };
  const out = new Map<number, EvidenceExchange>();
  for (const { e, d } of rows) {
    const doc = d as Doc;
    const mine = members.filter((m) => m.exchangeId === e.id);
    const refs = mine.map((m) => sourceRef(doc, m.l, m.role, inWindow(segs.get(m.l.id) ?? [], windowOf(m))));
    const asMembers = mine.map((m) => member(m.l, m.role, inWindow(segs.get(m.l.id) ?? [], windowOf(m))));
    const speaker = speakerStatusOf(e.kind, asMembers);
    const pieces = piecesOf(asMembers);
    const text = (role: "question" | "answer") => pieces.filter((p) => p[role]).map((p) => p.text).join("\n");
    out.set(e.id, {
      id: e.evidenceKey, rowId: e.id, caseId: doc.caseId, witnessId: doc.witnessId, witness: doc.witness, sessionId: doc.sessionId, sessionPart: doc.sessionPart, documentId: doc.id, documentSha256: doc.sha, takenOn: doc.takenOn,
      kind: e.kind, flags: e.flags,
      part: { groupId: e.groupId, partNo: e.partNo, partCount: e.partCount, sharedWithPrevious: e.partNo > 1 ? shared(e.depositionId, e.groupId, e.partNo, e.partNo - 1) : 0, sharedWithNext: e.partNo < e.partCount ? shared(e.depositionId, e.groupId, e.partNo, e.partNo + 1) : 0 },
      question: text("question"), answer: text("answer"),
      sourceStart: refs[0], sourceEnd: refs[refs.length - 1], lines: refs,
      speakerStatus: (e.speakerStatus as SpeakerStatus | null) ?? null, speakerReasons: speaker.reasons, textHash: e.textHash,
      integrity: {
        textHashMatches: e.textHash === null ? null : e.textHash === textHashOf(asMembers),
        speakerStatusMatches: e.speakerStatus === null ? null : e.speakerStatus === speaker.status,
      },
    });
  }
  return rowIds.map((id) => out.get(id)).filter((x): x is EvidenceExchange => x !== undefined);
}

// One exchange by its stable ID. The same file in two cases has the same IDs, so give the case when it
// could be in more than one; an ambiguous ID without one is an error, never a guess.
export async function getEvidence(db: Database, id: string, caseId?: number): Promise<EvidenceExchange | null> {
  const rows = await db.select({ id: exchanges.id }).from(exchanges).innerJoin(depositions, eq(depositions.id, exchanges.depositionId)).where(and(eq(exchanges.evidenceKey, id), caseId === undefined ? undefined : eq(depositions.caseId, caseId)));
  if (rows.length > 1) throw new Error(`Exchange ${id} is in ${rows.length} cases: give the case.`);
  return rows.length ? (await hydrate(db, [rows[0].id]))[0] : null;
}

export type SearchFilters = { caseId: number; witnessId?: number; sessionId?: number; documentId?: number; kinds?: string[]; limit?: number };

// Exchanges whose original question and answer words match the query (Postgres websearch syntax:
// words, "quoted phrases", OR, -excluded), best first. Parts of one long answer overlap, so each answer
// appears once, as its best-matching part. Nothing here comes from a model.
export async function searchEvidence(db: Database, query: string, f: SearchFilters) {
  const kinds = f.kinds ?? ["qa"];
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 200);
  const where: SQL[] = [sql`e.tsv @@ q`, sql`d.case_id = ${f.caseId}`, sql`e.kind::text in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`];
  if (f.witnessId !== undefined) where.push(sql`d.witness_id = ${f.witnessId}`);
  if (f.sessionId !== undefined) where.push(sql`d.session_id = ${f.sessionId}`);
  if (f.documentId !== undefined) where.push(sql`d.id = ${f.documentId}`);
  const result = await db.execute<{ id: string; rank: number; matched: string }>(sql`
    select id, rank, count(*) over () as matched from (
      select e.id, ts_rank(e.tsv, q) as rank,
        row_number() over (partition by e.deposition_id, e.group_id order by ts_rank(e.tsv, q) desc, e.part_no) as n
      from exchanges e join depositions d on d.id = e.deposition_id, websearch_to_tsquery('english', ${query}) q
      where ${sql.join(where, sql` and `)}
    ) x where n = 1 order by rank desc, id limit ${limit}`);
  const ids = result.rows.map((r) => Number(r.id));
  const records = await hydrate(db, ids);
  return { query, matched: Number(result.rows[0]?.matched ?? 0), results: records.map((exchange, i) => ({ rank: Number(result.rows[i].rank), exchange })) };
}

// A long answer whole: every part of the exchange's group, and its source lines once each, in order, so the
// overlap between parts is never read twice. Each part keeps its own ID.
export async function answerGroup(db: Database, id: string, caseId?: number) {
  const one = await getEvidence(db, id, caseId);
  if (!one) return null;
  const rowIds = (await db.select({ id: exchanges.id }).from(exchanges).where(and(eq(exchanges.depositionId, one.documentId), eq(exchanges.groupId, one.part.groupId))).orderBy(asc(exchanges.partNo))).map((r) => r.id);
  const parts = await hydrate(db, rowIds);
  const seen = new Map<number, SourceRef>();
  for (const p of parts) for (const l of p.lines) if (!seen.has(l.lineRowId)) seen.set(l.lineRowId, l);
  const lines = [...seen.values()].sort((x, y) => { const [, , p1, l1] = x.sourceId.split("_").map(Number); const [, , p2, l2] = y.sourceId.split("_").map(Number); return p1 - p2 || l1 - l2; });
  const said = (role: "question" | "answer") => piecesOf(lines.map((l) => ({ page: 0, line: 0, text: l.text, lineRole: l.lineRole, speakerRole: l.speaker, segments: l.segments?.map((s) => ({ role: s.speaker, start: s.start, end: s.end })) }))).filter((p) => p[role]).map((p) => p.text).join("\n");
  return { groupId: one.part.groupId, documentId: one.documentId, parts: parts.map((p) => ({ id: p.id, partNo: p.part.partNo, sourceStart: p.sourceStart.ref, sourceEnd: p.sourceEnd.ref, sharedWithPrevious: p.part.sharedWithPrevious })), lines, question: said("question"), answer: said("answer") };
}

// The source lines around an exchange, and the exchanges before and after it in its session, crossing
// into the session's previous or next file where it continues there.
export async function sourceContext(db: Database, id: string, opts: { caseId?: number; lines?: number } = {}) {
  const exchange = await getEvidence(db, id, opts.caseId);
  if (!exchange) return null;
  const n = Math.min(Math.max(opts.lines ?? 5, 0), 50);
  const [doc] = await db.select(docColumns).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(eq(depositions.id, exchange.documentId));
  const first = exchange.lines[0];
  const last = exchange.lines[exchange.lines.length - 1];
  const [firstRow, lastRow] = await Promise.all([first.lineRowId, last.lineRowId].map(async (rid) => (await db.select().from(lines).where(eq(lines.id, rid)))[0]));
  const before = (await db.select().from(lines).where(and(eq(lines.depositionId, exchange.documentId), sql`(${lines.printedPage}, ${lines.lineNo}) < (${firstRow.printedPage}, ${firstRow.lineNo})`)).orderBy(sql`${lines.printedPage} desc, ${lines.lineNo} desc`).limit(n)).reverse();
  const after = await db.select().from(lines).where(and(eq(lines.depositionId, exchange.documentId), sql`(${lines.printedPage}, ${lines.lineNo}) > (${lastRow.printedPage}, ${lastRow.lineNo})`)).orderBy(asc(lines.printedPage), asc(lines.lineNo)).limit(n);
  const neighbour = async (direction: "previous" | "next") => {
    const cmp = direction === "previous" ? sql`<` : sql`>`;
    const order = direction === "previous" ? sql`desc` : sql`asc`;
    const r = await db.execute<{ id: string }>(sql`
      select e.id from exchanges e join depositions d on d.id = e.deposition_id
      where d.session_id = ${exchange.sessionId} and (d.session_part, e.group_id, e.part_no) ${cmp} (${exchange.sessionPart}, ${exchange.part.groupId}, ${exchange.part.partNo})
      order by d.session_part ${order}, e.group_id ${order}, e.part_no ${order} limit 1`);
    if (!r.rows[0]) return null;
    const [x] = await hydrate(db, [Number(r.rows[0].id)]);
    return { id: x.id, rowId: x.rowId, documentId: x.documentId, kind: x.kind, sourceStart: x.sourceStart, sourceEnd: x.sourceEnd, crossesDocument: x.documentId !== exchange.documentId };
  };
  const segs = await segmentsOf(db, [...before, ...after].map((l) => l.id));
  return { exchange, before: before.map((l) => sourceRef(doc as Doc, l, "context", segs.get(l.id))), after: after.map((l) => sourceRef(doc as Doc, l, "context", segs.get(l.id))), previous: await neighbour("previous"), next: await neighbour("next") };
}

// What the index holds for each file of a case, and what it doesn't: files not read, pages with no text
// or never read, missing printed pages, witness lines in no exchange, and exchanges not yet indexed.
export async function evidenceCoverage(db: Database, caseId: number) {
  const docs = await db.select({ ...docColumns, status: depositions.status, filename: depositions.originalFilename, label: depositionSessions.label }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).innerJoin(depositionSessions, eq(depositionSessions.id, depositions.sessionId)).where(eq(depositions.caseId, caseId)).orderBy(asc(depositions.sessionId), asc(depositions.sessionPart));
  const documents = await Promise.all(docs.map(async (d) => {
    const stored = await db.select({ page: lines.printedPage, line: lines.lineNo }).from(lines).where(eq(lines.depositionId, d.id)).orderBy(asc(lines.printedPage), asc(lines.lineNo));
    const counts = await db.execute<{ kind: string; status: string | null; n: number }>(sql`select kind::text, speaker_status as status, count(*)::int as n from exchanges where deposition_id = ${d.id} group by 1, 2`);
    const [orphans] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from lines l where l.deposition_id = ${d.id} and l.speaker_role = 'witness' and not exists (select 1 from exchange_lines el where el.line_id = l.id)`)).rows;
    const by = (pred: (r: { kind: string; status: string | null }) => boolean) => counts.rows.filter(pred).reduce((n, r) => n + r.n, 0);
    const coverage = sessionCoverage(stored, (d.validation ?? null) as Parameters<typeof sessionCoverage>[1]);
    return {
      documentId: d.id, filename: d.filename, witnessId: d.witnessId, witness: d.witness, sessionId: d.sessionId, sessionPart: d.sessionPart, sessionLabel: d.label, takenOn: d.takenOn, status: d.status,
      scheme: schemeOf((d.validation as Validation | null)?.layout),
      lines: stored.length,
      exchanges: by(() => true),
      qaExchanges: by((r) => r.kind === "qa"),
      notIndexed: by((r) => r.status === null),
      speaker: { verified: by((r) => r.kind === "qa" && r.status === "verified"), uncertain: by((r) => r.kind === "qa" && r.status === "uncertain"), invalid: by((r) => r.kind === "qa" && r.status === "invalid") },
      witnessLinesInNoExchange: orphans.n,
      blankPages: coverage.blankPages,
      unreadPages: coverage.unreadPages,
      missingPages: coverage.gaps,
      notes: d.status === "ready" ? [] : [`not read (${d.status}): none of its testimony is indexed`],
    };
  }));
  // A session's files should share a date; a difference is reported, never resolved here.
  const sessions = [...new Set(documents.map((d) => d.sessionId))].map((sessionId) => {
    const parts = documents.filter((d) => d.sessionId === sessionId);
    const dates = [...new Set(parts.map((p) => p.takenOn).filter(Boolean))];
    return { sessionId, witness: parts[0].witness, files: parts.length, dates, notes: dates.length > 1 ? ["its files have different dates"] : [] };
  });
  const sum = (k: "lines" | "exchanges" | "qaExchanges" | "notIndexed" | "witnessLinesInNoExchange") => documents.reduce((n, d) => n + d[k], 0);
  return { caseId, documents, sessions, totals: { documents: documents.length, notRead: documents.filter((d) => d.status !== "ready").length, lines: sum("lines"), exchanges: sum("exchanges"), qaExchanges: sum("qaExchanges"), notIndexed: sum("notIndexed"), witnessLinesInNoExchange: sum("witnessLinesInNoExchange") } };
}

// Fills (or, with refresh, recomputes) the evidence fields of stored exchanges, from their lines, with the
// same functions ingestion uses. Idempotent: an exchange whose fields already match is left alone.
export async function indexEvidence(db: Database, scope: { caseId?: number; documentId?: number; refresh?: boolean } = {}) {
  const docs = await db.select({ id: depositions.id, sha: depositions.fileSha256 }).from(depositions).where(and(scope.caseId === undefined ? undefined : eq(depositions.caseId, scope.caseId), scope.documentId === undefined ? undefined : eq(depositions.id, scope.documentId)));
  const report = { documents: docs.length, examined: 0, written: 0, unchanged: 0, failed: [] as { exchangeId: number; error: string }[] };
  for (const d of docs) {
    const rows = await db.select({ id: exchanges.id, kind: exchanges.kind, key: exchanges.evidenceKey, hash: exchanges.textHash, status: exchanges.speakerStatus }).from(exchanges).where(and(eq(exchanges.depositionId, d.id), scope.refresh ? undefined : or(isNull(exchanges.evidenceKey), isNull(exchanges.textHash), isNull(exchanges.speakerStatus))));
    if (rows.length === 0) continue;
    const members = await db.select({ exchangeId: exchangeLines.exchangeId, role: exchangeLines.role, from: exchangeLines.segmentFrom, to: exchangeLines.segmentTo, l: lines }).from(exchangeLines).innerJoin(lines, eq(lines.id, exchangeLines.lineId)).where(inArray(exchangeLines.exchangeId, rows.map((r) => r.id)));
    const segs = await segmentsOf(db, members.map((m) => m.l.id));
    for (const r of rows) {
      report.examined++;
      try {
        const f = evidenceFieldsOf(d.sha, r.kind, members.filter((m) => m.exchangeId === r.id).map((m) => member(m.l, m.role, inWindow(segs.get(m.l.id) ?? [], windowOf(m)))));
        if (f.evidenceKey === r.key && f.textHash === r.hash && f.speakerStatus === r.status) {
          report.unchanged++;
          continue;
        }
        await db.update(exchanges).set(f).where(eq(exchanges.id, r.id));
        report.written++;
      } catch (error) {
        report.failed.push({ exchangeId: r.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
  }
  return report;
}

// A new, empty session of a witness, for files the caller will store as its parts.
export async function createSession(db: Database, s: { caseId: number; witnessId: number; label?: string | null }) {
  const [row] = await db.insert(depositionSessions).values({ caseId: s.caseId, witnessId: s.witnessId, label: s.label ?? null }).returning({ id: depositionSessions.id });
  return row.id;
}

// The next free part number of a session, to store another file in it.
export async function nextSessionPart(db: Database, sessionId: number) {
  const [r] = (await db.execute<{ n: number }>(sql`select coalesce(max(session_part), 0)::int + 1 as n from depositions where session_id = ${sessionId}`)).rows;
  return r.n;
}
