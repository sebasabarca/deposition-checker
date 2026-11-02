// Text transcripts: a .txt file or pasted text, read into the same page:line source lines as a PDF.
// Text with a line-number gutter keeps its own page:line. Text without one is never rejected: its
// non-empty lines are numbered in order on page 0, which the interface shows as "Line N" and which
// verification never lets reach the contradictions lane, because it is not an official citation.

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

const MAX_LINE_NO = 30; // a gutter number above this is a page number standing alone
const NUMBERED = /^\s*(\d{1,2})(?:\s+(.*?))?\s*$/;
const PAGE_MARK = /^\s*(?:page\s+(\d{1,5})(?:\s+of\s+\d+)?|(\d{1,5}))\s*$/i;
const QA = /^\s*[QA](?:[.:]|\s|$)/;
const NUMBERED_SHARE = 0.6;

// Plain UTF-8 with no NUL bytes. A PDF is checked first, so this only decides text versus junk.
export function isText(data: Uint8Array): boolean {
  if (data.length === 0 || data.subarray(0, 65536).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

const line = (page: number, pdfPage: number, lineNo: number, text: string): SourceLine => ({
  pdfPage,
  printedPage: page,
  lineNo,
  lineFromPosition: lineNo,
  indentX: QA.test(text) ? 0 : 100,
  rawText: text.trim(),
});

export function readTextPages(text: string): { layout: LayoutProfile; pages: PageExtraction[] } {
  const rows = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const content = rows.filter((r) => r.trim());
  const numberedRows = content.filter((r) => {
    const m = r.match(NUMBERED);
    return m !== null && Number(m[1]) >= 1 && Number(m[1]) <= MAX_LINE_NO;
  });
  if (content.length === 0 || numberedRows.length / content.length < NUMBERED_SHARE) {
    const lines = content.map((r, i) => line(UNNUMBERED_PAGE, 1, i + 1, r));
    return { layout: TEXT_UNNUMBERED_V1, pages: lines.length ? [{ pdfPage: 1, hasText: true, printedPage: UNNUMBERED_PAGE, footer: [], lines, unnumbered: [] }] : [] };
  }

  // A page starts where the gutter restarts (or a form feed or "Page N" row says so); its number is
  // the one printed above it when there is one, otherwise one more than the last.
  const pages: PageExtraction[] = [];
  let pending: number | null = null;
  let current: PageExtraction | null = null;
  const open = () => {
    const printed: number = pending ?? (current?.printedPage ?? 0) + 1;
    current = { pdfPage: pages.length + 1, hasText: true, printedPage: printed, footer: [], lines: [], unnumbered: [] };
    pages.push(current);
    pending = null;
  };
  for (const raw of rows) {
    if (raw.includes("\f") && current) pending = pending ?? (current as PageExtraction).printedPage! + 1;
    const row = raw.replaceAll("\f", "");
    const m = row.match(NUMBERED);
    const n = m ? Number(m[1]) : NaN;
    if (m && n >= 1 && n <= MAX_LINE_NO) {
      const last = (current as PageExtraction | null)?.lines.at(-1);
      if (!current || pending !== null || (last && n <= last.lineNo)) open();
      current!.lines.push(line(current!.printedPage!, current!.pdfPage, n, m[2] ?? ""));
      continue;
    }
    const mark = row.match(PAGE_MARK);
    if (mark) pending = Number(mark[1] ?? mark[2]);
    else if (row.trim() && current) (current as PageExtraction).unnumbered.push(row.trim());
  }
  return { layout: TEXT_NUMBERED_V1, pages };
}

export function readText(data: Uint8Array, witnessSurname?: string) {
  const { layout, pages } = readTextPages(new TextDecoder("utf-8").decode(data));
  const lineCount = pages.reduce((n, p) => n + p.lines.length, 0);
  const validation: Validation = {
    status: lineCount > 0 ? "ready" : "unsupported",
    layout: layout.name,
    pageCount: pages.length,
    counts: { text: pages.length, blank: 0, needs_ocr: 0, failed: 0 },
    needsOcrPages: [],
    blankPages: [],
    failedPages: [],
    reasons: lineCount > 0 ? [] : ["the text is empty"],
    pages: pages.map((p) => ({ pdfPage: p.pdfPage, printedPage: p.printedPage, status: "text", lineCount: p.lines.length, failures: [] })),
  };
  const exchanges = validation.status === "ready" ? buildExchangeParts(pages.flatMap((p) => p.lines), layout, witnessSurname) : null;
  return { pdf: { pageCount: pages.length, pages }, validation, exchanges };
}
