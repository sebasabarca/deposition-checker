// The date a deposition was taken, as the transcript states it on its cover. Pure. Only a suggestion:
// the interface asks a person to confirm it, and warns when a date they entered differs.
//
// Only the opening pages count (printed page 1 or 2, or the first lines of text without page numbers),
// because later pages are full of other dates: an e-mail, a letter, an exhibit the witness is asked about.
// The date must sit on, or just below, a line that names the session ("taken", "held", "deposition of"),
// and never on a line about a document.

import type { PageExtraction } from "./pdf";

export type DateFound = { date: string; ref: string; text: string }; // YYYY-MM-DD; page:line; the line itself

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = new RegExp(String.raw`\b(${MONTHS.join("|")})\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})/(\d{1,2})/(\d{4})\b`, "i");
const SESSION = /\b(taken|held|commenc\w*|deposition|interview|examination|hearing|proceedings|reported by|date:)/i;
const DOCUMENT = /\b(exhibit|e-?mail|letter|memo\w*|dated|document|signed|expires?)\b/i;
const OPENING_PAGES = 2;
const UNNUMBERED_LINES = 60;
const LOOK_BACK = 3; // lines above the date that may name the session

function isoOf(m: RegExpMatchArray): string | null {
  const [y, mo, d] = m[1] ? [Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2])] : [Number(m[6]), Number(m[4]), Number(m[5])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2100 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function findSessionDate(pages: readonly PageExtraction[]): DateFound | null {
  const opening = pages
    .filter((p) => p.printedPage !== null && p.printedPage <= OPENING_PAGES)
    .flatMap((p) => (p.printedPage === 0 ? p.lines.slice(0, UNNUMBERED_LINES) : p.lines));
  for (const [i, line] of opening.entries()) {
    const m = line.rawText.match(DATE);
    if (!m || DOCUMENT.test(line.rawText)) continue;
    const named = opening.slice(Math.max(0, i - LOOK_BACK), i + 1).some((l) => SESSION.test(l.rawText) && !DOCUMENT.test(l.rawText));
    const date = isoOf(m);
    if (named && date) return { date, ref: `${line.printedPage}:${line.lineNo}`, text: line.rawText.trim() };
  }
  return null;
}
