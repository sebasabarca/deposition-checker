// A text PDF with printed line numbers in a layout other than the validated one (ellison-doj-v1): its own
// text layer read page by page, by the numbers printed beside each line, before any OCR. The PDF gives
// the page boundaries, so only the numbers themselves are read from the text:
// - a row is line n when its leading number (after any clock time) continues the page's count;
// - every other row is a header, footer or note, kept out of the testimony and counted;
// - the printed page number is a number standing at the right of the page, alone or ending a header or
//   footer row; a page without one gets the number after the previous page's, flagged as inferred;
// - rows without a number that sit between line a and line b, exactly as many as the numbers missing
//   between them, are those lines (a text layer can lose a number the page shows), flagged as inferred.
// A page with no numbered lines (a cover, an exhibit slip-sheet) stays out of the testimony and is named in
// a warning. Null when no page has numbered lines, or fewer than half the rows carry one.

import { groupRows, joinRow, type TextItem } from "./pdf";
import type { LayoutProfile } from "./layout";
import type { PageExtraction } from "./pdf";
import { TEXT_NUMBERED_V1, textLine, type TextPages } from "./text";

const CLOCK = /^\d{1,2}:\d{2}:\d{2}\s?[AaPp]\.?[Mm]\.?\s*/; // realtime exports print the time before the number
const LINE = /^(\d{1,2})(?:\s+(.*))?$/;
const MAX_LINE_NO = 30;
const PAGE_NUMBER = /^(?:page\s+)?(\d{1,5})$|^-\s*(\d{1,5})\s*-$/i;
const PAGE_NUMBER_INDENT = 100; // points right of the page's leftmost text: well clear of the line numbers
const MIN_NUMBERED_SHARE = 0.5;

const listed = (ns: (number | string)[]) => (ns.length > 8 ? `${ns.slice(0, 8).join(", ")} and ${ns.length - 8} more` : ns.join(", "));

export function readNumberedPdfPages(itemsByPage: TextItem[][], layout: LayoutProfile): TextPages | null {
  const pages: PageExtraction[] = [];
  const inferred: number[] = [];
  const withoutLines: number[] = [];
  const filled: string[] = []; // page:line references whose number was inferred from position
  let rowCount = 0;
  let lineCount = 0;
  let timed = 0;
  for (const [i, items] of itemsByPage.entries()) {
    const pdfPage = i + 1;
    const rows = groupRows(items, layout);
    if (rows.length === 0) {
      withoutLines.push(pdfPage);
      continue;
    }
    const left = Math.min(...items.map((t) => t.x));
    const farRight = (t: TextItem) => t.x > left + PAGE_NUMBER_INDENT;
    let printed: number | null = null;
    let next = 1;
    const found: { lineNo: number; text: string }[] = [];
    const unnumbered: string[] = [];
    let between: string[] = []; // unnumbered rows since the last numbered line
    const fill: { after: number; rows: string[] }[] = [];
    for (const row of rows) {
      rowCount++;
      const text = joinRow(row, layout).trim();
      const alone = text.match(PAGE_NUMBER);
      if (alone && farRight(row[0])) {
        printed ??= Number(alone[1] ?? alone[2]);
        continue;
      }
      const untimed = text.replace(CLOCK, "");
      const m = untimed.match(LINE);
      if (m && Number(m[1]) >= next && Number(m[1]) <= MAX_LINE_NO) {
        if (untimed !== text) timed++;
        const lineNo = Number(m[1]);
        const previous = found.at(-1)?.lineNo;
        if (previous !== undefined && between.length > 0 && lineNo - previous - 1 === between.length) fill.push({ after: previous, rows: between });
        between = [];
        found.push({ lineNo, text: m[2] ?? "" });
        next = Number(m[1]) + 1;
        continue;
      }
      const last = row.at(-1)!;
      if (printed === null && row.length > 1 && farRight(last) && /^\d{1,5}$/.test(last.str.trim())) {
        printed = Number(last.str.trim());
        unnumbered.push(joinRow(row.slice(0, -1), layout).trim());
      } else {
        unnumbered.push(text);
        between.push(text);
      }
    }
    if (found.length === 0) {
      withoutLines.push(pdfPage);
      continue;
    }
    if (printed === null) {
      printed = (pages.at(-1)?.printedPage ?? 0) + 1;
      inferred.push(pdfPage);
    }
    for (const { after, rows } of fill) {
      rows.forEach((text, k) => {
        found.push({ lineNo: after + 1 + k, text });
        unnumbered.splice(unnumbered.indexOf(text), 1);
        filled.push(`${printed}:${after + 1 + k}`);
      });
    }
    found.sort((a, b) => a.lineNo - b.lineNo);
    lineCount += found.length;
    const page = printed;
    pages.push({ pdfPage, hasText: true, printedPage: page, footer: [], unnumbered, lines: found.map((l) => textLine(page, pdfPage, l.lineNo, l.text)) });
  }
  if (pages.length === 0 || lineCount < rowCount * MIN_NUMBERED_SHARE) return null;

  const warnings: string[] = [];
  if (withoutLines.length) warnings.push(`PDF page ${listed(withoutLines)} ${withoutLines.length === 1 ? "has" : "have"} no line numbers (a cover, an exhibit or a blank page) and ${withoutLines.length === 1 ? "is" : "are"} kept out of the testimony.`);
  if (inferred.length) warnings.push(`Page ${listed(inferred.map((p) => pages[p - 1].printedPage!))} ${inferred.length === 1 ? "has" : "have"} no printed page number; the number was inferred from the page before. Verify it against the PDF.`);
  if (filled.length) warnings.push(`Line ${listed(filled)} ${filled.length === 1 ? "has" : "have"} no number in the PDF's text; ${filled.length === 1 ? "it was" : "they were"} numbered by position between the lines around ${filled.length === 1 ? "it" : "them"}. Verify against the PDF before citing.`);
  const gaps = pages.filter((p) => p.lines.some((l, i) => l.lineNo !== (i === 0 ? 1 : p.lines[i - 1].lineNo + 1)));
  if (gaps.length) warnings.push(`Line numbers skip on page ${listed(gaps.map((p) => p.printedPage!))}. Lines that are missing from the file can't be cited.`);
  const backwards = pages.filter((p, i) => i > 0 && p.printedPage! <= pages[i - 1].printedPage!);
  if (backwards.length) warnings.push(`Page numbers don't increase at page ${listed(backwards.map((p) => p.printedPage!))}. Check that the file is one transcript, in order.`);
  const loose = pages.flatMap((p) => p.unnumbered).filter(Boolean);
  if (loose.length) warnings.push(`${loose.length} ${loose.length === 1 ? "row has" : "rows have"} no line number (headers, footers or text between lines, such as "${loose[0].slice(0, 60)}") and ${loose.length === 1 ? "is" : "are"} kept out of the testimony.`);
  if (timed) warnings.push(`Timestamps beside the line numbers were removed from ${timed} ${timed === 1 ? "line" : "lines"}; the testimony text is unchanged.`);
  return { layout: TEXT_NUMBERED_V1, pages, inferredPages: inferred, warnings };
}
