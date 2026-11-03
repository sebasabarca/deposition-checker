// Text transcripts: a court reporter's ASCII export (.txt, .asc), pasted text, or the text the RTF and
// DOCX adapters extract, read into the same page:line source lines as a PDF. Text with a line-number
// gutter keeps its own page:line. Text without one is never rejected: its non-empty lines are numbered
// in order on page 0, which the interface shows as "Line N" and which verification never lets reach
// the contradictions lane, because it is not an official citation.
//
// Nothing is guessed silently: a page number that isn't printed is inferred and flagged, timestamps
// beside the line numbers are removed and counted, and every oddity is a warning on the deposition.

import { buildExchangeParts } from "./exchanges";
import type { LayoutProfile } from "./layout";
import type { PageExtraction, SourceLine } from "./pdf";
import type { Validation } from "./validate";

const TEXT_BASE: Omit<LayoutProfile, "name"> = {
  firstLineY: 0,
  lineSpacing: 0,
  maxLinesPerPage: 25,
  headerMinY: 0,
  footerMaxY: 0,
  rowTolerance: 0,
  wordGap: 0,
  // Text has no geometry, so turns are told by content: a Q or A marker gets indent 0 and every other
  // line an indent past this threshold, where markLine looks for speaker labels instead.
  turnIndentMaxX: 50,
  printedPage: /^$/,
  footer: /^$/,
};
export const TEXT_NUMBERED_V1: LayoutProfile = { ...TEXT_BASE, name: "text-numbered-v1", pageBreaksContinue: true };
export const TEXT_UNNUMBERED_V1: LayoutProfile = { ...TEXT_BASE, name: "text-unnumbered-v1", maxLinesPerPage: Number.MAX_SAFE_INTEGER };
export const UNNUMBERED_PAGE = 0;
// Archives that number every statement once, in one count with no pages ("1 DANIEL PETROCELLI: ...",
// "5820 A: ..."). That number is the reference: kept as the line number, never recounted, on page 0 like
// other text without pages, so it is cited as "Line N" and never as an official page:line. An archive
// whose count starts again (a page in sections) is stored in parts, one per run of the count, each part
// in the page field (1, 2, ...), so "Part 3, Line 233" names one statement; still never official.
export const TEXT_ARCHIVE_V1: LayoutProfile = { ...TEXT_UNNUMBERED_V1, name: "text-archive-lines-v1" };

const MAX_LINE_NO = 30; // a gutter number above this is a page number standing alone
const NUMBERED = /^(\s*)(\d{1,2})(?:\s+(.*?))?\s*$/;
const PAGE_MARK = /^\s*(?:page\s+(\d{1,5})(?:\s+of\s+\d+)?|-\s*(\d{1,5})\s*-|(\d{1,5}))\s*$/i;
const QA = /^\s*[QA](?:[.:]|\s|$)/;
const NUMBERED_SHARE = 0.6;
// A bare number this many columns away from the line-number gutter is a page number, not a line.
const PAGE_NUMBER_OFFSET = 4;
// Realtime and video-synced exports print a clock time (with seconds) beside each line number.
const TIME = String.raw`\d{1,2}:\d{2}:\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?`;
const LEADING_TIME = new RegExp(String.raw`^\s*${TIME}\s*(?=\d{1,2}(?:\s|$))`);
const AFTER_NUMBER_TIME = new RegExp(String.raw`^${TIME}(?:\s+|$)`);
const TRAILING_TIME = new RegExp(String.raw`\s{2,}${TIME}\s*$`);

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

// Text in one of the encodings court-reporter software writes: UTF-8 (or UTF-16 with its byte-order
// mark), else Windows-1252, the usual ANSI code page of older CAT software. Null for binary data:
// NUL bytes without a UTF-16 mark, or too many control characters to be a transcript.
export function decodeText(data: Uint8Array): { text: string; encoding: TextEncoding } | null {
  if (data.length === 0) return null;
  const bom = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : null;
  if (bom) {
    if (data.length % 2 !== 0) return null; // UTF-16 comes in pairs of bytes; an odd length is damaged or not text
    try {
      return { text: new TextDecoder(bom, { fatal: true }).decode(data.subarray(2)), encoding: bom };
    } catch {
      return null;
    }
  }
  const head = data.subarray(0, 65536);
  if (head.includes(0)) return null;
  // Tab, line feed, form feed and carriage return are text; other C0 controls in quantity mean binary.
  let controls = 0;
  for (const b of head) if (b < 0x20 && b !== 9 && b !== 10 && b !== 12 && b !== 13) controls++;
  if (controls > head.length * 0.01) return null;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(data), encoding: "windows-1252" };
  }
}

export const isText = (data: Uint8Array): boolean => decodeText(data) !== null;

// Whether most rows start with a line number: a numbered transcript, even when its layout isn't one we know.
export function looksNumbered(rows: string[]): boolean {
  const content = rows.map((r) => r.replaceAll("\f", "")).filter((r) => r.trim());
  const numbered = content.filter((r) => {
    const m = r.match(NUMBERED);
    return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= MAX_LINE_NO;
  });
  return content.length > 0 && numbered.length / content.length >= NUMBERED_SHARE;
}

export const textLine = (page: number, pdfPage: number, lineNo: number, text: string): SourceLine => ({
  pdfPage,
  printedPage: page,
  lineNo,
  lineFromPosition: lineNo,
  indentX: QA.test(text) ? 0 : 100,
  rawText: text.trim(),
});

export type TextPages = { layout: LayoutProfile; pages: PageExtraction[]; inferredPages: number[]; warnings: string[] };

// One row with its timestamps removed, and whether there were any.
function untimed(row: string): { row: string; timed: boolean } {
  const lead = row.replace(LEADING_TIME, (m) => " ".repeat(m.length));
  const trail = lead.replace(TRAILING_TIME, "");
  return { row: trail, timed: trail !== row };
}

// The column where line numbers end, read from the rows that have text after their number. Line
// numbers are right-aligned in a fixed gutter; a page number sits elsewhere (usually far right).
function gutterEnd(rows: string[]): number | null {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const m = r.match(NUMBERED);
    if (m && m[3] && Number(m[2]) <= MAX_LINE_NO) {
      const end = m[1].length + m[2].length;
      counts.set(end, (counts.get(end) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  for (const [end, n] of counts) if (best === null || n > counts.get(best)!) best = end;
  return best;
}

const listed = (ns: number[]) => (ns.length > 8 ? `${ns.slice(0, 8).join(", ")} and ${ns.length - 8} more` : ns.join(", "));

const RECORD = /^\s*(\d{1,6})\s+(\S.*?)\s*$/;
const ARCHIVE_SHARE = 0.9;

const RESTART_FROM = 5; // a new run of the count starts at 1 or close to it

// Pure. Null unless nearly every row is a record whose number counts up by one, past what a page holds.
// A number lower than the one before starts a new part, if it starts near 1; anything else going
// backwards means the numbers can't name one record each, so the text isn't read this way.
// Rows before the first record are a header, kept out; a row without a number continues the record above.
export function readArchiveRecords(rows: string[]): TextPages | null {
  const content = rows.map((r) => r.replaceAll("\f", "")).filter((r) => r.trim());
  const ids = content.map((r) => r.match(RECORD)).filter((m) => m !== null).map((m) => Number(m[1]));
  if (ids.length < content.length * ARCHIVE_SHARE || Math.max(0, ...ids) <= MAX_LINE_NO) return null;
  if (ids.some((n, i) => i > 0 && n <= ids[i - 1] && n > RESTART_FROM)) return null;
  if (ids.filter((n, i) => i > 0 && (n === ids[i - 1] + 1 || n < ids[i - 1])).length < (ids.length - 1) * ARCHIVE_SHARE) return null;
  const records: { part: number; id: number; text: string }[] = [];
  const header: string[] = [];
  let continued = 0;
  for (const row of content) {
    const m = row.match(RECORD);
    const last = records.at(-1);
    if (m) records.push({ part: last && Number(m[1]) <= last.id ? last.part + 1 : (last?.part ?? 1), id: Number(m[1]), text: m[2] });
    else if (records.length) {
      records[records.length - 1].text += ` ${row.trim()}`;
      continued++;
    } else header.push(row.trim());
  }
  const parts = records.at(-1)?.part ?? 1;
  const pageOf = (part: number) => (parts === 1 ? UNNUMBERED_PAGE : part);
  const pages = Array.from({ length: parts }, (_, i): PageExtraction => ({ pdfPage: 1, hasText: true, printedPage: pageOf(i + 1), footer: i === 0 ? header : [], unnumbered: [], lines: records.filter((r) => r.part === i + 1).map((r) => textLine(pageOf(i + 1), 1, r.id, r.text)) }));
  const warnings = parts === 1
    ? [`This text numbers each statement in one continuous count, with no pages (as public archives do), so references are cited as "Line N" using that number. They are not official page:line citations: check them against the certified transcript.`]
    : [`This text numbers each statement in a count that starts again ${parts - 1} ${parts === 2 ? "time" : "times"} (as some public archives do), so each run of the count is a part, and references are cited as "Part P, Line N". They are not official page:line citations: check them against the certified transcript.`];
  if (header.length) warnings.push(`${header.length} ${header.length === 1 ? "row" : "rows"} before the first numbered statement (a title or source note) ${header.length === 1 ? "is" : "are"} kept out of the testimony.`);
  if (continued) warnings.push(`${continued} ${continued === 1 ? "row without a number was" : "rows without a number were"} joined to the statement above ${continued === 1 ? "it" : "them"}.`);
  return { layout: TEXT_ARCHIVE_V1, pages, inferredPages: [], warnings };
}

export function readTextPages(text: string): TextPages {
  const warnings: string[] = [];
  let timedRows = 0;
  const rows = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n").map((r) => {
    const t = untimed(r.replaceAll("\t", "    "));
    if (t.timed) timedRows++;
    return t.row;
  });
  const archive = readArchiveRecords(rows);
  if (archive) return archive;
  if (!looksNumbered(rows)) {
    const content = rows.filter((r) => r.replaceAll("\f", "").trim());
    const lines = content.map((r, i) => textLine(UNNUMBERED_PAGE, 1, i + 1, r.replaceAll("\f", "")));
    if (lines.length) warnings.push("This text has no page and line numbers, so its lines are numbered in order and can't be cited by page:line. Ask the court reporter for the plain-text (.txt) or PDF transcript, which has them.");
    return { layout: TEXT_UNNUMBERED_V1, pages: lines.length ? [{ pdfPage: 1, hasText: true, printedPage: UNNUMBERED_PAGE, footer: [], lines, unnumbered: [] }] : [], inferredPages: [], warnings };
  }

  // A page starts where the gutter restarts (or a form feed or page-number row says so); its number is
  // the one printed above it when there is one, otherwise one more than the last, flagged as inferred.
  const gutter = gutterEnd(rows.map((r) => r.replaceAll("\f", "")));
  const pages: PageExtraction[] = [];
  const inferred: number[] = [];
  let pending: number | null = null;
  let printedMark = false; // whether `pending` was printed, rather than counted on from a form feed
  let current: PageExtraction | null = null;
  const open = () => {
    const printed: number = pending ?? (current?.printedPage ?? 0) + 1;
    current = { pdfPage: pages.length + 1, hasText: true, printedPage: printed, footer: [], lines: [], unnumbered: [] };
    if (!printedMark) inferred.push(current.pdfPage);
    pages.push(current);
    pending = null;
    printedMark = false;
  };
  for (const raw of rows) {
    if (raw.includes("\f") && current && pending === null) pending = (current as PageExtraction).printedPage! + 1;
    const row = raw.replaceAll("\f", "");
    const m = row.match(NUMBERED);
    const n = m ? Number(m[2]) : NaN;
    const awayFromGutter = m !== null && !m[3] && gutter !== null && Math.abs(m[1].length + m[2].length - gutter) > PAGE_NUMBER_OFFSET;
    if (m && n >= 1 && n <= MAX_LINE_NO && !awayFromGutter) {
      const last = (current as PageExtraction | null)?.lines.at(-1);
      if (!current || pending !== null || (last && n <= last.lineNo)) open();
      const body = (m[3] ?? "").replace(AFTER_NUMBER_TIME, () => {
        timedRows++;
        return "";
      });
      current!.lines.push(textLine(current!.printedPage!, current!.pdfPage, n, body));
      continue;
    }
    const mark = row.match(PAGE_MARK);
    if (mark) {
      pending = Number(mark[1] ?? mark[2] ?? mark[3]);
      printedMark = true;
    }
    else if (row.trim() && current) (current as PageExtraction).unnumbered.push(row.trim());
  }

  // What a reader should know before citing these pages.
  if (inferred.length) warnings.push(`Page ${listed(inferred.map((p) => pages[p - 1].printedPage!))} ${inferred.length === 1 ? "has" : "have"} no printed page number; the number was inferred from the page before. Verify it against the certified transcript.`);
  const gaps = pages.filter((p) => p.lines.some((l, i) => i > 0 && l.lineNo !== p.lines[i - 1].lineNo + 1) || (p.lines[0] && p.lines[0].lineNo !== 1));
  if (gaps.length) warnings.push(`Line numbers skip on page ${listed(gaps.map((p) => p.printedPage!))}. Lines that are missing from the file can't be cited.`);
  const backwards = pages.filter((p, i) => i > 0 && p.printedPage! <= pages[i - 1].printedPage!);
  if (backwards.length) warnings.push(`Page numbers don't increase at page ${listed(backwards.map((p) => p.printedPage!))}. Check that the file is one transcript, in order.`);
  const loose = pages.flatMap((p) => p.unnumbered);
  if (loose.length) warnings.push(`${loose.length} ${loose.length === 1 ? "row has" : "rows have"} no line number (headers, footers or text between lines, such as "${loose[0].slice(0, 60)}") and ${loose.length === 1 ? "is" : "are"} kept out of the testimony.`);
  if (timedRows) warnings.push(`Timestamps beside the line numbers were removed from ${timedRows} ${timedRows === 1 ? "line" : "lines"}; the testimony text is unchanged.`);
  return { layout: TEXT_NUMBERED_V1, pages, inferredPages: inferred, warnings };
}

// Reads extracted transcript text. `notes` are the extracting adapter's own warnings (encoding,
// unreadable parts of an RTF or DOCX), shown with the parser's.
export function readTextTranscript(text: string, witnessSurname?: string, notes: string[] = []) {
  return transcriptFromPages(readTextPages(text), witnessSurname, notes);
}

// Validation and exchanges for pages read by printed page and line (text, or a PDF's text layer).
export function transcriptFromPages({ layout, pages, inferredPages, warnings }: TextPages, witnessSurname?: string, notes: string[] = []) {
  const lineCount = pages.reduce((n, p) => n + p.lines.length, 0);
  const validation: Validation = {
    status: lineCount > 0 ? "ready" : "unsupported",
    layout: layout.name,
    pageCount: pages.length,
    counts: { text: pages.length, blank: 0, needs_ocr: 0, failed: 0 },
    needsOcrPages: [],
    blankPages: [],
    failedPages: [],
    reasons: lineCount > 0 ? [] : ["the file has no transcript text"],
    pages: pages.map((p) => ({ pdfPage: p.pdfPage, printedPage: p.printedPage, status: "text", lineCount: p.lines.length, failures: [] })),
    warnings: [...notes, ...warnings],
    inferredPages,
  };
  const exchanges = validation.status === "ready" ? buildExchangeParts(pages.flatMap((p) => p.lines), layout, witnessSurname) : null;
  return { pdf: { pageCount: pages.length, pages }, validation, exchanges };
}

export function readText(data: Uint8Array, witnessSurname?: string) {
  const decoded = decodeText(data);
  if (!decoded) return readTextTranscript("", witnessSurname, ["The file isn't readable as text."]);
  const notes = decoded.encoding === "windows-1252" ? ["This file uses an older text encoding, so check accented letters and quotation marks against the certified transcript."] : [];
  return readTextTranscript(decoded.text, witnessSurname, notes);
}
