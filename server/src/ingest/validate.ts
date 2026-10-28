// Gives every PDF page an explicit status and decides whether a deposition can be used.
// Pure: no I/O. The checks are the ones the parser spike used to measure accuracy, turned
// into gates, so a layout the parser wasn't validated on is reported instead of trusted.

import type { LayoutProfile } from "./layout";
import type { PageExtraction } from "./pdf";

export type PageStatus = "text" | "blank" | "needs_ocr" | "failed";
export type DepositionStatus = "ready" | "needs_review" | "unsupported";

export type PageFailureReason =
  | "printed_page_missing"
  | "printed_page_not_increasing"
  | "unnumbered_row"
  | "line_out_of_range"
  | "line_position_mismatch"
  | "line_duplicate"
  | "line_out_of_order"
  | "unexpected_footer"
  | "footer_page_mismatch";

export type PageFailure = { reason: PageFailureReason; detail: string };

export type PageValidation = {
  pdfPage: number;
  printedPage: number | null;
  status: PageStatus;
  lineCount: number;
  failures: PageFailure[];
};

export type Validation = {
  status: DepositionStatus;
  layout: string;
  pageCount: number;
  counts: Record<PageStatus, number>;
  needsOcrPages: number[];
  blankPages: number[];
  failedPages: number[];
  reasons: string[]; // why the deposition is not ready; empty when it is
  pages: PageValidation[];
};

export function validatePage(page: PageExtraction, previousPrintedPage: number | null, layout: LayoutProfile): PageValidation {
  const result: PageValidation = {
    pdfPage: page.pdfPage,
    printedPage: page.printedPage,
    status: "text",
    lineCount: page.lines.length,
    failures: [],
  };
  if (!page.hasText) return { ...result, status: "needs_ocr" };

  const fail = (reason: PageFailureReason, detail: string) => result.failures.push({ reason, detail });

  for (const row of page.footer) {
    const footer = row.trim().match(layout.footer);
    if (!footer) fail("unexpected_footer", row.trim());
    else if (Number(footer[1]) !== page.pdfPage) fail("footer_page_mismatch", `footer says ${footer[1]}`);
  }
  for (const row of page.unnumbered) fail("unnumbered_row", row.trim());

  // A blank page may still carry a printed page number, so it is order-checked too.
  if (page.printedPage !== null && previousPrintedPage !== null && page.printedPage <= previousPrintedPage) {
    fail("printed_page_not_increasing", `p.${page.printedPage} follows p.${previousPrintedPage}`);
  }

  const isBlank = isBlankPage(page);
  if (!isBlank) {
    if (page.printedPage === null) fail("printed_page_missing", "no printed page number at the top of the page");

    const seen = new Set<number>();
    let previousLine = 0;
    for (const line of page.lines) {
      if (line.lineNo < 1 || line.lineNo > layout.maxLinesPerPage) fail("line_out_of_range", `line ${line.lineNo}`);
      if (line.lineFromPosition !== line.lineNo) {
        fail("line_position_mismatch", `line ${line.lineNo} sits in slot ${line.lineFromPosition}`);
      }
      if (seen.has(line.lineNo)) fail("line_duplicate", `line ${line.lineNo}`);
      else if (line.lineNo < previousLine) fail("line_out_of_order", `line ${line.lineNo} after line ${previousLine}`);
      seen.add(line.lineNo);
      previousLine = Math.max(previousLine, line.lineNo);
    }
  }

  if (result.failures.length > 0) return { ...result, status: "failed" };
  return { ...result, status: isBlank ? "blank" : "text" };
}

// Has text, but only a header or footer: no transcript lines and no unplaced rows.
export function isBlankPage(page: PageExtraction): boolean {
  return page.hasText && page.lines.length === 0 && page.unnumbered.length === 0;
}

export function validateDeposition(pages: PageExtraction[], layout: LayoutProfile): Validation {
  // Page order uses two baselines. A text page is compared with the last text page, whose number
  // is backed by checked lines, so a wrong number on a blank page is never blamed on the text page
  // after it. A numbered blank page is compared with the last numbered page of either kind, so
  // consecutive blank pages that repeat or go backwards are caught. A numbered blank page must
  // also come before the next text page.
  const results: PageValidation[] = [];
  let lastText: number | null = null;
  let lastNumbered: number | null = null;
  for (const page of pages) {
    const result = validatePage(page, isBlankPage(page) ? lastNumbered : lastText, layout);
    results.push(result);
    if (result.status === "text") lastText = lastNumbered = page.printedPage;
    if (result.status === "blank" && page.printedPage !== null) lastNumbered = page.printedPage;
  }
  results.forEach((result, i) => {
    if (result.status !== "blank" || result.printedPage === null) return;
    const next = results.slice(i + 1).find((r) => r.status === "text");
    if (next?.printedPage != null && result.printedPage >= next.printedPage) {
      result.status = "failed";
      result.failures.push({ reason: "printed_page_not_increasing", detail: `p.${result.printedPage} comes before p.${next.printedPage}` });
    }
  });

  const counts: Record<PageStatus, number> = { text: 0, blank: 0, needs_ocr: 0, failed: 0 };
  for (const r of results) counts[r.status]++;
  const pagesWith = (status: PageStatus) => results.filter((r) => r.status === status).map((r) => r.pdfPage);

  const reasons: string[] = [];
  if (counts.needs_ocr > 0) reasons.push(`${counts.needs_ocr} of ${results.length} pages have no text layer (OCR is not supported)`);
  if (counts.failed > 0) reasons.push(`${counts.failed} of ${results.length} pages do not match layout ${layout.name}`);
  if (results.length === 0) reasons.push("the PDF has no pages");

  const status: DepositionStatus =
    counts.text === 0 ? "unsupported" : counts.needs_ocr > 0 || counts.failed > 0 ? "needs_review" : "ready";
  if (status === "unsupported" && reasons.length === 0) reasons.push("no page contains transcript lines");

  return {
    status,
    layout: layout.name,
    pageCount: results.length,
    counts,
    needsOcrPages: pagesWith("needs_ocr"),
    blankPages: pagesWith("blank"),
    failedPages: pagesWith("failed"),
    reasons,
    pages: results,
  };
}
