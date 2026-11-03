// PDFs with a text layer but no line-number gutter. They are never rejected for that alone, and never
// given invented court-reporter line numbers: each page's rows are numbered in order on that PDF page
// ("physical lines"). The deposition is marked by its layout, the interface and report label every such
// reference as not official, and verification never lets it reach the contradictions lane.
//
// A PDF whose rows mostly start with a line number does have printed numbers, in a layout we don't
// know; it is left unsupported rather than renumbered, because printed numbers always take priority.

import { buildExchangeParts } from "./exchanges";
import type { LayoutProfile } from "./layout";
import type { PageExtraction } from "./pdf";
import { looksNumbered, TEXT_NUMBERED_V1, textLine } from "./text";
import type { PageStatus, Validation } from "./validate";

// Content-based turns as for text; a page break continues when the next page's first row is line 1.
export const PDF_PHYSICAL_V1: LayoutProfile = { ...TEXT_NUMBERED_V1, name: "pdf-physical-v1", maxLinesPerPage: Number.MAX_SAFE_INTEGER };
export const PHYSICAL_LINES_WARNING = "This PDF has no printed line numbers, so Veridict counted the lines on each page. These counts are not the court reporter's official line numbers: check each reference against the certified transcript before citing it.";

const EDGE_ROWS = 5; // a running header or footer sits within this many rows of the top or bottom
const shape = (row: string) => row.trim().toLowerCase().replace(/\d+/g, "#");
// A turn is testimony however often it repeats ("A. Yes."), so it is never taken for a header.
const TURN = /^\s*(?:[QA](?:[.:]|\s|$)|[A-Z][A-Z .'-]+:)/;

// Rows near the top or bottom that repeat on at least half the pages with text (page numbers aside) are
// running headers and footers: kept in the page's record, out of the testimony. Pure.
export function readPhysicalPages(rowsByPage: string[][]): { pages: PageExtraction[]; running: number } {
  const edge = (rows: string[], j: number) => (j < EDGE_ROWS || j >= rows.length - EDGE_ROWS) && !TURN.test(rows[j]);
  const seen = new Map<string, number>();
  for (const rows of rowsByPage) for (const s of new Set(rows.filter((_, j) => edge(rows, j)).map(shape))) seen.set(s, (seen.get(s) ?? 0) + 1);
  const withText = rowsByPage.filter((rows) => rows.length > 0).length;
  const runningShapes = new Set([...seen].filter(([, n]) => n >= 2 && n >= withText / 2).map(([s]) => s));
  let running = 0;
  const pages = rowsByPage.map((rows, i): PageExtraction => {
    const pdfPage = i + 1;
    const footer = rows.filter((r, j) => edge(rows, j) && runningShapes.has(shape(r)));
    running += footer.length;
    const kept = rows.filter((r, j) => !(edge(rows, j) && runningShapes.has(shape(r))));
    return { pdfPage, hasText: rows.length > 0, printedPage: pdfPage, footer, lines: kept.map((r, k) => textLine(pdfPage, pdfPage, k + 1, r)), unnumbered: [] };
  });
  return { pages, running };
}

// Null when the rows look numbered (see above). `notes` are warnings from earlier attempts, such as OCR
// being unavailable.
export function readPhysicalPdf(rowsByPage: string[][], witnessSurname?: string, notes: string[] = []) {
  if (looksNumbered(rowsByPage.flat())) return null;
  const { pages, running } = readPhysicalPages(rowsByPage);
  const statusOf = (p: PageExtraction): PageStatus => (!p.hasText ? "needs_ocr" : p.lines.length ? "text" : "blank");
  const counts: Record<PageStatus, number> = { text: 0, blank: 0, needs_ocr: 0, failed: 0 };
  for (const p of pages) counts[statusOf(p)]++;
  const pagesWith = (s: PageStatus) => pages.filter((p) => statusOf(p) === s).map((p) => p.pdfPage);
  const status = counts.text === 0 ? "unsupported" : counts.needs_ocr > 0 ? "needs_review" : "ready";
  const warnings = [...notes, PHYSICAL_LINES_WARNING];
  if (running) warnings.push(`${running} repeated header or footer ${running === 1 ? "row was" : "rows were"} kept out of the testimony.`);
  const validation: Validation = {
    status,
    layout: PDF_PHYSICAL_V1.name,
    pageCount: pages.length,
    counts,
    needsOcrPages: pagesWith("needs_ocr"),
    blankPages: pagesWith("blank"),
    failedPages: [],
    reasons: status === "ready" ? [] : status === "unsupported" ? ["the PDF has no transcript text"] : [`${counts.needs_ocr} of ${pages.length} pages have no readable text`],
    pages: pages.map((p) => ({ pdfPage: p.pdfPage, printedPage: p.printedPage, status: statusOf(p), lineCount: p.lines.length, failures: [] })),
    warnings,
  };
  const exchanges = status === "ready" ? buildExchangeParts(pages.flatMap((p) => p.lines), PDF_PHYSICAL_V1, witnessSurname) : null;
  return { pdf: { pageCount: pages.length, pages }, validation, exchanges };
}

export const hasPhysicalLines = (validation: Pick<Validation, "layout"> | null | undefined) => validation?.layout === PDF_PHYSICAL_V1.name;
