// Extracts page:line source lines from a deposition PDF's text layer with pdfjs-dist.
// Layout assumptions (checked against the Ellison P3171 PDF, reported in docs/parser-spike.md):
//   - the printed page number ("00009") is the topmost text on the page
//   - a footer ("Ellison 01-20-04" and the PDF page number) sits near the bottom
//   - every transcript line starts with its line number, 1..25, in a left gutter
// Nothing is OCR'd: a page with no text is reported in needsOcr, never dropped silently.
// A page whose only text is the header or footer (P3173 has 9) is reported in blankPages.

export type PdfLine = {
  pdfPage: number; // 1-based page index in the file
  printedPage: number | null;
  line: number;
  lineFromPosition: number | null; // line slot implied by the vertical position, for cross-checking
  indentX: number | null; // x of the text when it starts in its own item right of the gutter (a turn or paragraph indent)
  text: string;
};

export type PdfPageReport = {
  pdfPage: number;
  printedPage: number | null;
  items: number;
  stripped: string[]; // header and footer text removed from the page
  unnumbered: string[]; // text rows with no leading line number (kept out of lines, reported)
};

export type PdfReadResult = { lines: PdfLine[]; pages: PdfPageReport[]; needsOcr: number[]; blankPages: number[] };

export type TextItem = { str: string; x: number; y: number; width: number };

const ROW_TOLERANCE = 1.5; // items within this many points vertically form one row
const WORD_GAP = 1; // a horizontal gap wider than this (points) between items becomes a space
const LINE_SPACING = 22.5;
const FIRST_LINE_Y = 697.5;
const FOOTER_MAX_Y = 100;
const HEADER_MIN_Y = 700;
const PRINTED_PAGE = /^\d{3,6}$/;
const LINE_NUMBER = /^(\d{1,2})(?:\s+|$)/;

export function groupRows(items: TextItem[]): TextItem[][] {
  const rows: TextItem[][] = [];
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - item.y) <= ROW_TOLERANCE) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

export function joinRow(row: TextItem[]): string {
  let text = "";
  let end: number | null = null;
  for (const item of row) {
    if (end !== null && item.x - end > WORD_GAP && !text.endsWith(" ")) text += " ";
    text += item.str;
    end = item.x + item.width;
  }
  return text;
}

export function readPageItems(pdfPage: number, items: TextItem[]): { lines: PdfLine[]; report: PdfPageReport } {
  const report: PdfPageReport = { pdfPage, printedPage: null, items: items.length, stripped: [], unnumbered: [] };
  const lines: PdfLine[] = [];

  for (const row of groupRows(items)) {
    const y = row[0].y;
    const text = joinRow(row);
    if (y >= HEADER_MIN_Y && PRINTED_PAGE.test(text.trim()) && report.printedPage === null) {
      report.printedPage = Number(text.trim());
      report.stripped.push(text);
      continue;
    }
    if (y <= FOOTER_MAX_Y) {
      report.stripped.push(text);
      continue;
    }
    const number = text.match(LINE_NUMBER);
    const line = number ? Number(number[1]) : NaN;
    if (!number || line < 1 || line > 25) {
      report.unnumbered.push(text);
      continue;
    }
    const slot = Math.round((FIRST_LINE_Y - y) / LINE_SPACING) + 1;
    lines.push({
      pdfPage,
      printedPage: report.printedPage,
      line,
      lineFromPosition: slot >= 1 && slot <= 25 ? slot : null,
      indentX: row.length > 1 && /^\d{1,2}$/.test(row[0].str.trim()) ? row[1].x : null,
      text: text.slice(number[0].length),
    });
  }
  return { lines, report };
}

export async function readPdf(path: string): Promise<PdfReadResult> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ url: path, verbosity: 0 }).promise;
  const result: PdfReadResult = { lines: [], pages: [], needsOcr: [], blankPages: [] };

  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const items: TextItem[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width });
    }
    if (!items.some((i) => i.str.trim())) {
      result.needsOcr.push(p);
      result.pages.push({ pdfPage: p, printedPage: null, items: 0, stripped: [], unnumbered: [] });
      continue;
    }
    const { lines, report } = readPageItems(p, items);
    if (lines.length === 0 && report.unnumbered.length === 0) result.blankPages.push(p);
    result.lines.push(...lines);
    result.pages.push(report);
  }
  await doc.destroy();
  return result;
}
