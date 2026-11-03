// Stage 2 input: one deposition's logical answer groups, rebuilt from the stored Stage 1 evidence, as
// units the extraction model reads. The pure builder takes stored rows; loadDocument reads them.
//
// A unit is one answer group: every part of an exchange group, with the lines parts share read once
// (as evidence/store.ts answerGroup does), so a long answer is never extracted twice from overlapping
// parts. Its citable spans are its source lines, except that a line holding several speakers' turns
// (Stage 1 speaker segments) gives one span per segment in this exchange, each with its own speaker, so
// an attorney's words on a witness's line are never read as testimony. A group too long for one request
// is cut into windows of whole spans that overlap and repeat the question; a single span too long for
// any request makes the unit incomplete, never truncated.

import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { depositions, exchangeLines, exchanges, lineSegments, lines } from "../../db/schema";
import { formatRef, schemeOf, sourceLineId, type ReferenceScheme } from "../../evidence/references";
import { inWindow } from "../../ingest/rows";
import type { Validation } from "../../ingest/validate";

export const MAX_UNIT_CHARS = 12_000; // a window's own spans; context and labels come on top
export const WINDOW_OVERLAP_SPANS = 3;
export const CONTEXT_SPANS = 6; // the end of the answer group before, shown as context only

export type SpeakerStatus = "verified" | "uncertain" | "invalid";
export type Span = {
  sourceSpanId: string; // Stage 1 source line ID, with "#<seq>" for one speaker segment of it
  lineId: number;
  exchangeId: number; // the first part of the group holding the line
  position: string; // "page:line" as stored
  ref: string; // as the transcript cites it
  speaker: string; // attorney | witness | colloquy | parenthetical | unknown
  speakerName: string | null;
  role: "question" | "answer" | "context" | "unknown"; // its role in the exchange
  text: string; // the stored text, or the segment's characters of it
  exchangeStatus: SpeakerStatus | null; // Stage 1 speaker status of that part
};
export type Unit = {
  unitKey: string;
  depositionId: number;
  caseId: number;
  witnessId: number;
  groupId: number;
  windowNo: number;
  windowCount: number;
  exchangeIds: number[];
  spans: Span[]; // citable, in transcript order
  context: Span[]; // the testimony just before, never citable
  sourceHash: string;
  testimony: boolean; // holds words the witness (or an unidentified speaker) said
  oversized: string | null; // why it can't be sent whole, when a single span exceeds the limit
};

export type StoredMember = { lineId: number; page: number; line: number; text: string; lineRole: string; speakerRole: string; speakerName: string | null; segments: { seq: number; start: number; end: number; role: string; name: string | null }[] };
export type StoredPart = { id: number; groupId: number; partNo: number; kind: string; speakerStatus: string | null; members: StoredMember[] };
export type StoredDocument = { id: number; caseId: number; witnessId: number; sha: string; scheme: ReferenceScheme; parts: StoredPart[] };

const ROLE_OF_SPEAKER: Record<string, Span["role"]> = { attorney: "question", witness: "answer", colloquy: "context", parenthetical: "context", unknown: "unknown" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const unitKeyOf = (fileSha: string, first: string, last: string, windowNo: number, windowCount: number) => `fu_${sha(`${fileSha}|${first}|${last}|${windowNo}/${windowCount}`).slice(0, 24)}`;
export const sourceHashOf = (spans: readonly Span[]) => sha(spans.map((s) => `${s.sourceSpanId}\t${s.speaker}\t${s.role}\t${s.text}`).join("\n"));

function spansOfGroup(doc: StoredDocument, parts: StoredPart[]): Span[] {
  const seen = new Set<number>();
  const out: { order: number; span: Span }[] = [];
  for (const p of [...parts].sort((a, b) => a.partNo - b.partNo)) {
    for (const m of p.members) {
      if (seen.has(m.lineId)) continue;
      seen.add(m.lineId);
      const base = { lineId: m.lineId, exchangeId: p.id, position: `${m.page}:${m.line}`, ref: formatRef(doc.scheme, m.page, m.line), exchangeStatus: (p.speakerStatus as SpeakerStatus | null) ?? null };
      const order = m.page * 1e6 + m.line;
      const id = sourceLineId(doc.sha, m.page, m.line);
      if (m.segments.length) {
        for (const s of m.segments) out.push({ order, span: { ...base, sourceSpanId: `${id}#${s.seq}`, speaker: s.role, speakerName: s.name, role: ROLE_OF_SPEAKER[s.role] ?? "unknown", text: m.text.slice(s.start, s.end) } });
      } else {
        out.push({ order, span: { ...base, sourceSpanId: id, speaker: m.speakerRole, speakerName: m.speakerName, role: m.lineRole as Span["role"], text: m.text } });
      }
    }
  }
  return out.sort((a, b) => a.order - b.order).map((x) => x.span); // stable: a line's segments stay in order
}

// Windows of whole spans, each at most MAX_UNIT_CHARS of its own spans, consecutive windows sharing
// WINDOW_OVERLAP_SPANS; every window after the first starts with the question spans that open the group.
export function windowsOf(spans: readonly Span[], max = MAX_UNIT_CHARS, overlap = WINDOW_OVERLAP_SPANS): Span[][] {
  const size = (ss: readonly Span[]) => ss.reduce((n, s) => n + s.text.length + 1, 0);
  if (size(spans) <= max) return [[...spans]];
  const firstAnswer = spans.findIndex((s) => s.role === "answer");
  const head = firstAnswer > 0 ? spans.slice(0, firstAnswer) : [];
  const rest = spans.slice(head.length);
  const windows: Span[][] = [];
  let start = 0;
  while (start < rest.length) {
    const window = [...head];
    let end = start;
    while (end < rest.length && (end === start || size([...window, ...rest.slice(start, end + 1)]) <= max)) end++;
    windows.push([...window, ...rest.slice(start, end)]);
    if (end >= rest.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return windows;
}

// Pure. Every Q/A answer group of the document as one or more units, in transcript order.
export function buildUnits(doc: StoredDocument): Unit[] {
  const qa = doc.parts.filter((p) => p.kind === "qa");
  const groups = [...new Set(qa.map((p) => p.groupId))].sort((a, b) => a - b);
  const units: Unit[] = [];
  let previous: Span[] = [];
  for (const g of groups) {
    const parts = qa.filter((p) => p.groupId === g);
    const spans = spansOfGroup(doc, parts);
    if (spans.length === 0) continue;
    const testimony = spans.some((s) => s.speaker === "witness" || s.speaker === "unknown");
    const tooLong = spans.find((s) => s.text.length > MAX_UNIT_CHARS);
    const windows = tooLong ? [spans] : windowsOf(spans);
    windows.forEach((w, k) => {
      units.push({
        unitKey: unitKeyOf(doc.sha, spans[0].position, spans[spans.length - 1].position, k + 1, windows.length),
        depositionId: doc.id, caseId: doc.caseId, witnessId: doc.witnessId, groupId: g, windowNo: k + 1, windowCount: windows.length,
        exchangeIds: [...new Set(w.map((s) => s.exchangeId))],
        spans: w,
        context: k === 0 ? previous.slice(-CONTEXT_SPANS) : [],
        sourceHash: sourceHashOf(w),
        testimony,
        oversized: tooLong ? `source line ${tooLong.ref} holds ${tooLong.text.length} characters, more than one request may carry (${MAX_UNIT_CHARS}); it is kept whole for another method, never cut` : null,
      });
    });
    previous = spans;
  }
  return units;
}

// The stored rows buildUnits needs, in four queries.
export async function loadDocument(db: Database, documentId: number): Promise<StoredDocument & { parserVersion: string; status: string; excludedReason: string | null }> {
  const [d] = await db.select().from(depositions).where(eq(depositions.id, documentId));
  if (!d) throw new Error(`No document ${documentId}.`);
  const rows = await db.select({ id: exchanges.id, groupId: exchanges.groupId, partNo: exchanges.partNo, kind: exchanges.kind, speakerStatus: exchanges.speakerStatus }).from(exchanges).where(eq(exchanges.depositionId, documentId));
  const ids = rows.map((r) => r.id);
  const members = ids.length ? await db.select({ exchangeId: exchangeLines.exchangeId, role: exchangeLines.role, from: exchangeLines.segmentFrom, to: exchangeLines.segmentTo, l: lines }).from(exchangeLines).innerJoin(lines, eq(lines.id, exchangeLines.lineId)).where(and(eq(exchangeLines.depositionId, documentId), inArray(exchangeLines.exchangeId, ids))).orderBy(asc(lines.printedPage), asc(lines.lineNo)) : [];
  const segs = await db.select().from(lineSegments).where(eq(lineSegments.depositionId, documentId)).orderBy(asc(lineSegments.lineId), asc(lineSegments.seq));
  const segsOf = new Map<number, typeof segs>();
  for (const s of segs) segsOf.set(s.lineId, [...(segsOf.get(s.lineId) ?? []), s]);
  const byPart = new Map<number, StoredMember[]>();
  for (const m of members) {
    const window = m.from === null || m.to === null ? null : { from: m.from, to: m.to };
    const mine = inWindow(segsOf.get(m.l.id) ?? [], window).map((s) => ({ seq: s.seq, start: s.startOffset, end: s.endOffset, role: s.speakerRole, name: s.speakerName }));
    byPart.set(m.exchangeId, [...(byPart.get(m.exchangeId) ?? []), { lineId: m.l.id, page: m.l.printedPage, line: m.l.lineNo, text: m.l.rawText, lineRole: m.role, speakerRole: m.l.speakerRole, speakerName: m.l.speakerName, segments: mine }]);
  }
  return {
    id: d.id, caseId: d.caseId, witnessId: d.witnessId, sha: d.fileSha256, scheme: schemeOf((d.validation as Validation | null)?.layout), parserVersion: d.parserVersion, status: d.status, excludedReason: d.excludedReason,
    parts: rows.map((r) => ({ ...r, members: byPart.get(r.id) ?? [] })),
  };
}
