// Reads a deposition PDF's text layer into page:line source lines with pdfjs-dist.
// Extraction only: it never decides whether a page is valid. validate.ts does that, so a page
// that doesn't match the layout is reported, not silently repaired or dropped.
// Ported from scripts/spike/pdf.ts, which was validated on Ellison P3171 and P3173.

import type { LayoutProfile } from "./layout";

export type TextItem = { str: string; x: number; y: number; width: number };

export type SourceLine = {
  pdfPage: number; // 1-based page index in the file
  printedPage: number | null;
  lineNo: number;
  lineFromPosition: number; // line slot implied by the vertical position, for cross-checking
  indentX: number | null; // x of the text when it starts in its own item right of the gutter
  rawText: string; // the line's text without the line-number gutter
};

export type PageExtraction = {
  pdfPage: number;
  hasText: boolean; // false means no text layer at all
  printedPage: number | null;
  footer: string[]; // rows in the footer zone, kept so validation can check them
  lines: SourceLine[];
  unnumbered: string[]; // rows outside the footer that don't start with a line number
};

export type ExtractedPdf = { pageCount: number; pages: PageExtraction[] };

const LINE_NUMBER = /^(\d{1,2})(?:\s+|$)/;

export function groupRows(items: TextItem[], layout: LayoutProfile): TextItem[][] {
  const rows: TextItem[][] = [];
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - item.y) <= layout.rowTolerance) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

export function joinRow(row: TextItem[], layout: LayoutProfile): string {
  let text = "";
  let end: number | null = null;
  for (const item of row) {
    if (end !== null && item.x - end > layout.wordGap && !text.endsWith(" ")) text += " ";
    text += item.str;
    end = item.x + item.width;
  }
  return text;
}

export function readPageItems(pdfPage: number, items: TextItem[], layout: LayoutProfile): PageExtraction {
  const page: PageExtraction = {
    pdfPage,
    hasText: items.some((i) => i.str.trim()),
    printedPage: null,
    footer: [],
    lines: [],
    unnumbered: [],
  };

  for (const row of groupRows(items, layout)) {
    const y = row[0].y;
    const text = joinRow(row, layout);
    if (y >= layout.headerMinY && page.printedPage === null && layout.printedPage.test(text.trim())) {
      page.printedPage = Number(text.trim());
      continue;
    }
    if (y <= layout.footerMaxY) {
      page.footer.push(text);
      continue;
    }
    const number = text.match(LINE_NUMBER);
    if (!number) {
      page.unnumbered.push(text);
      continue;
    }
    page.lines.push({
      pdfPage,
      printedPage: page.printedPage,
      lineNo: Number(number[1]),
      lineFromPosition: Math.round((layout.firstLineY - y) / layout.lineSpacing) + 1,
      indentX: row.length > 1 && /^\d{1,2}$/.test(row[0].str.trim()) ? row[1].x : null,
      rawText: text.slice(number[0].length),
    });
  }
  return page;
}

// Throws if pdfjs cannot open the file; the caller reports that as an unsupported deposition.
export async function extractPdf(data: Uint8Array, layout: LayoutProfile): Promise<ExtractedPdf> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs takes ownership of the buffer it is given, so pass a copy and leave the caller's bytes intact.
  const doc = await getDocument({ data: data.slice(), verbosity: 0 }).promise;
  try {
    const pages: PageExtraction[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      const items: TextItem[] = [];
      for (const item of content.items) {
        if ("str" in item) items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width });
      }
      pages.push(readPageItems(p, items, layout));
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}
