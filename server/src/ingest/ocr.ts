// Reads scanned deposition pages with Tesseract, locally: testimony never leaves the machine. The
// result is a PageExtraction like any other, so validation and exchange building need no OCR logic.
//
// OCR text isn't the exact evidence a text layer is, so nothing here is taken on trust. Line numbers
// come from a grid fitted to the gutter digits, and a digit that disagrees with its position fails
// validation rather than moving a citation. Handwriting between lines belongs to no line, and is
// counted, never merged into testimony. Every line keeps its confidence.
//
// shortcut: only the 25-line layout with a left gutter and the page number at the right, bottom (the
// Gates scans) or top (the January 6 Committee transcripts), is supported. Other layouts fail validation.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LayoutProfile } from "./layout";
import type { PageExtraction, SourceLine } from "./pdf";

const run = promisify(execFile);

export const OCR_DPI = 300;
export const MAX_OCR_PAGES = 500;
const OCR_CONCURRENCY = 4;
const PAGE_TIMEOUT_MS = 120_000;
const points = (px: number) => (px * 72) / OCR_DPI;
const GUTTER_EDGE = 82; // where indents are measured from, so one threshold fits every page

// Measured on the Gates scans, in points from the gutter digits' right edge, which moves up to 25
// points between pages because the paper fed differently: text starts 22 right of it, Q and A
// markers near 73, and paragraph or colloquy indents near 118.
export const SCANNED_25_V1: LayoutProfile = {
  name: "scanned-25-v1",
  firstLineY: 0,
  lineSpacing: 0,
  maxLinesPerPage: 25,
  headerMinY: 0,
  footerMaxY: 0,
  rowTolerance: 0,
  wordGap: 0,
  turnIndentMaxX: GUTTER_EDGE + 93,
  printedPage: /^\D{0,2}(\d{1,6})\D{0,2}$/,
  footer: /^$/,
};
const GUTTER_MARGIN = 10; // a word ending this far past the digit column's edge is body text
const CONTINUATION_INDENT = GUTTER_EDGE + 48; // text starting left of this continues a turn, whatever its first letter
const PAGE_WIDTH = 612;
// Q and A markers stand alone in their column. A wrong marker gives the witness's words to the attorney,
// so position decides: a short token here is a marker even when OCR misread it ("AL", "0.").
const MARKER_COLUMN = { min: GUTTER_EDGE + 53, max: GUTTER_EDGE + 93 };
const MISREAD_MARKER: [RegExp, string][] = [[/^[QO0][.,:;'’]?$/, "Q."], [/^[A4][.,:;'’LlIi1]?$/, "A."]];
const MIN_GRID_DIGITS = 5;
const ROW_FIT = 0.33; // share of the line spacing a word may sit from its row
const NOISE_CONFIDENCE = 60; // a symbol-only word below this is a speck on the scan
export const LOW_WORD_CONFIDENCE = 60;

export type Grid = { first: number; spacing: number };
export type OcrWord = { left: number; top: number; width: number; height: number; confidence: number; text: string };
export type OcrStats = { meanConfidence: number | null; lowConfidenceWords: number; annotations: string[]; noiseWords: number; coverPage: boolean; markersCorrected: number; pipesCorrected: number; grid: Grid | null };
export type OcrPage = PageExtraction & { ocr: OcrStats };

export function parseTsv(tsv: string): OcrWord[] {
  const [header, ...rows] = tsv.split("\n");
  const at = (name: string) => header.split("\t").indexOf(name);
  const [left, top, width, height, conf, text] = ["left", "top", "width", "height", "conf", "text"].map(at);
  return rows.flatMap((row) => {
    const c = row.split("\t");
    const value = c[text]?.trim();
    if (!value || Number(c[conf]) < 0) return [];
    return [{ left: Number(c[left]), top: Number(c[top]), width: Number(c[width]), height: Number(c[height]), confidence: Number(c[conf]), text: value }];
  });
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const centre = (w: OcrWord) => w.top + w.height / 2;

// Fits y = first + spacing × (line - 1) to gutter digits. Misread digits vote against each other, so
// the fit is the median over pairs, and a page without enough readable digits gets no grid.
export function fitGrid(digits: readonly { line: number; y: number }[]): Grid | null {
  if (digits.length < MIN_GRID_DIGITS) return null;
  const slopes: number[] = [];
  digits.forEach((a, i) => digits.slice(i + 1).forEach((b) => b.line !== a.line && slopes.push((b.y - a.y) / (b.line - a.line))));
  const spacing = median(slopes);
  if (!(spacing > 0)) return null;
  return { first: median(digits.map((d) => d.y - spacing * (d.line - 1))), spacing };
}

// A digit too faint to read falls back on its position, as does one OCR read partly ("2" for 12, "1"
// for 19). Any other disagreement stays visible, and validation fails the page.
export const lineNumberAt = (slot: number, read: number | undefined) => (read === undefined || String(slot).includes(String(read)) ? slot : read);

// One page's words as transcript lines. Pure. `first` marks the file's first page: a first page with
// no printed number is a cover sheet, reported as such, with no lines.
export function readOcrPage(pdfPage: number, words: readonly OcrWord[], first: boolean, previous: Grid | null = null): OcrPage {
  const stats: OcrStats = { meanConfidence: null, lowConfidenceWords: 0, annotations: [], noiseWords: 0, coverPage: false, markersCorrected: 0, pipesCorrected: 0, grid: null };
  const page: OcrPage = { pdfPage, hasText: words.some((w) => /[A-Za-z0-9]/.test(w.text)), printedPage: null, footer: [], lines: [], unnumbered: [], ocr: stats };
  if (!page.hasText) return page;

  const inLeftHalf = words.filter((w) => /^\d{1,2}$/.test(w.text) && Number(w.text) <= SCANNED_25_V1.maxLinesPerPage && points(w.left) < PAGE_WIDTH / 2);
  const edge = inLeftHalf.length ? median(inLeftHalf.map((w) => points(w.left + w.width))) : 0;
  const gutter = words.filter((w) => points(w.left + w.width) <= edge + GUTTER_MARGIN);
  const digits = gutter.filter((w) => inLeftHalf.includes(w)).map((w) => ({ line: Number(w.text), y: centre(w) }));
  // A very short page has too few digits of its own: it takes the previous page's grid, and a digit
  // that then disagrees fails validation.
  const grid = fitGrid(digits) ?? (digits.length > 0 ? previous : null);
  stats.grid = grid;
  const printed = (candidates: readonly OcrWord[]) => candidates.filter((w) => points(w.left) > PAGE_WIDTH / 2).map((w) => w.text.match(SCANNED_25_V1.printedPage)?.[1]).find((n) => n !== undefined && n.length >= 2);
  if (!grid) {
    // A cover sheet has no page number to cite. Anything else without a grid can't be placed.
    if (first && printed(words.slice(-12)) === undefined) stats.coverPage = true;
    else page.unnumbered.push(...words.map((w) => w.text));
    return page;
  }
  const slotOf = (w: OcrWord) => (centre(w) - grid.first) / grid.spacing + 1;
  // A page number can sit above line 1, where a single digit is a real page, not a misread speck.
  const top = words.filter((w) => !gutter.includes(w) && slotOf(w) < 0.5 && /^\d{1,4}$/.test(w.text) && points(w.left) > PAGE_WIDTH / 2).at(-1)?.text;
  const body = words.filter((w) => !gutter.includes(w));
  const rows = new Map<number, OcrWord[]>();
  const below: OcrWord[] = [];
  const stray: OcrWord[] = [];
  for (const w of body) {
    const slot = slotOf(w);
    const nearest = Math.round(slot);
    if (slot > SCANNED_25_V1.maxLinesPerPage + 0.5) below.push(w);
    else if (w.text === top && slot < 0.5) continue;
    else if (Math.abs(slot - nearest) > ROW_FIT || nearest < 1) stray.push(w);
    else if (!/[A-Za-z0-9]/.test(w.text) && w.confidence < NOISE_CONFIDENCE) stats.noiseWords++;
    else rows.set(nearest, [...(rows.get(nearest) ?? []), w]);
  }

  const number = printed(below) ?? top;
  page.printedPage = number === undefined ? null : Number(number);
  stats.annotations.push(...stray.map((w) => w.text));
  if (first && page.printedPage === null) {
    stats.coverPage = true;
    return page;
  }

  const read = new Map<number, number>(digits.map((d) => [Math.round((d.y - grid.first) / grid.spacing) + 1, d.line]));
  const confidences: number[] = [];
  for (const slot of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(slot)!.sort((a, b) => a.left - b.left);
    // A gutter digit that OCR joined to a speck ("23.") and read past the column isn't testimony.
    if (row.length === 1 && Number(row[0].text.match(/^(\d{1,2})\W*$/)?.[1]) === slot) {
      stats.noiseWords++;
      continue;
    }
    const start = points(row[0].left) - edge + GUTTER_EDGE;
    const asRead = row.map((w) => w.text).join(" ");
    const marker = start >= MARKER_COLUMN.min && start <= MARKER_COLUMN.max && row.length > 1 ? MISREAD_MARKER.find(([read]) => read.test(row[0].text))?.[1] : undefined;
    if (marker && !/^[QA]\.?$/.test(row[0].text)) { // "A" and "A." are both as printed
      stats.markersCorrected++;
      row[0] = { ...row[0], text: marker };
    }
    confidences.push(...row.map((w) => w.confidence));
    stats.lowConfidenceWords += row.filter((w) => w.confidence < LOW_WORD_CONFIDENCE).length;
    // The transcript's capital "I" reads as a bar, at full confidence. A lone bar is never testimony.
    for (const [i, w] of row.entries()) if (w.text === "|") {
      stats.pipesCorrected++;
      row[i] = { ...w, text: "I" };
    }
    const line: SourceLine = {
      pdfPage,
      printedPage: page.printedPage,
      lineNo: lineNumberAt(slot, read.get(slot)),
      lineFromPosition: slot,
      indentX: start < CONTINUATION_INDENT ? null : start,
      rawText: row.map((w) => w.text).join(" "),
      ...(row.map((w) => w.text).join(" ") === asRead ? {} : { ocrText: asRead }),
      ocrConfidence: Math.round(row.reduce((n, w) => n + w.confidence, 0) / row.length),
    };
    page.lines.push(line);
  }
  stats.meanConfidence = confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null;
  return page;
}

// Fills a page number OCR couldn't read or misread, only when the pages on both sides leave exactly
// one possible value (602, ?, 604). Anything less certain stays as read, and validation fails it.
// Returns the PDF pages changed, which are reported. Excerpts skip pages, so a wider gap proves nothing.
export function inferPageNumbers(pages: OcrPage[]): number[] {
  const inferred: number[] = [];
  pages.forEach((page, i) => {
    const [before, after] = [pages[i - 1]?.printedPage, pages[i + 1]?.printedPage];
    if (before == null || after == null || after !== before + 2 || page.printedPage === before + 1 || page.lines.length === 0) return;
    page.printedPage = before + 1;
    for (const line of page.lines) line.printedPage = before + 1;
    inferred.push(page.pdfPage);
  });
  return inferred;
}

export type OcrResult = { available: true; engine: string; pages: OcrPage[] } | { available: false; reason: string };
export type OcrReader = (data: Uint8Array, pageCount: number) => Promise<OcrResult>;

// Renders every page and reads it. A missing tool isn't a crash: the deposition stays needs_ocr with
// that reason. Paths reach the tools as arguments, never through a shell.
export const ocrDocument: OcrReader = async (data, pageCount) => {
  if (pageCount > MAX_OCR_PAGES) return { available: false, reason: `the file has ${pageCount} pages; OCR reads at most ${MAX_OCR_PAGES}` };
  let engine: string;
  try {
    const version = await run("tesseract", ["--version"]);
    await run("pdftoppm", ["-v"]);
    engine = `${version.stdout.split("\n")[0].trim()}, ${OCR_DPI} dpi`;
  } catch {
    return { available: false, reason: "OCR tools aren't installed on this server (tesseract and poppler)" };
  }
  const dir = await mkdtemp(join(tmpdir(), "deposition-ocr-"));
  try {
    const pdf = join(dir, "file.pdf");
    await writeFile(pdf, data);
    await run("pdftoppm", ["-r", String(OCR_DPI), "-gray", pdf, join(dir, "page")], { timeout: PAGE_TIMEOUT_MS * Math.max(1, pageCount) });
    const images = (await readdir(dir)).filter((f) => f.endsWith(".pgm")).sort();
    const words: OcrWord[][] = [];
    for (let i = 0; i < images.length; i += OCR_CONCURRENCY) {
      const batch = images.slice(i, i + OCR_CONCURRENCY).map((image) => run("tesseract", [join(dir, image), "stdout", "--psm", "6", "tsv"], { timeout: PAGE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }));
      words.push(...(await Promise.all(batch)).map((r) => parseTsv(r.stdout)));
    }
    const pages: OcrPage[] = [];
    for (const [i, w] of words.entries()) pages.push(readOcrPage(i + 1, w, i === 0, pages.at(-1)?.ocr.grid ?? null));
    return { available: true, engine, pages };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
