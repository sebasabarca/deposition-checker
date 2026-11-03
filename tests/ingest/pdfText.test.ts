// Text PDFs with printed line numbers in a layout other than ellison-doj-v1: read from their own text
// layer by those numbers, not by OCR.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ELLISON_DOJ_V1 as LAYOUT, readDeposition } from "../../server/src/ingest";
import type { TextItem } from "../../server/src/ingest/pdf";
import { readNumberedPdfPages } from "../../server/src/ingest/pdfText";

// One row of a page: its items' text and x, at height y.
const row = (y: number, ...cells: [string, number][]): TextItem[] => cells.map(([str, x]) => ({ str, x, y, width: str.length * 6 }));
const page = (...rows: TextItem[][]) => rows.flat();

describe("readNumberedPdfPages (pure)", () => {
  it("reads lines by their printed numbers, with the page number from the right and clock times removed", () => {
    const pages = readNumberedPdfPages(
      [
        page(row(700, ["In The Matter Of:", 250])), // a cover with no line numbers
        page(row(750, ["7", 570]), row(700, ["09:35:50AM 1", 20], ["Q. Where were you?", 112]), row(680, ["2", 86]), row(660, ["09:36:04AM 3", 20], ["A. At home.", 112])),
        page(row(750, ["NOT FOR", 214], ["COUNSEL'S EYES ONLY", 267], ["8", 525]), row(700, ["1", 68], ["Q", 88], ["And after that?", 115]), row(680, ["3", 68], ["A", 88], ["Nothing.", 115]), row(100, ["Jenny the Court Reporter", 200])),
      ],
      LAYOUT,
    )!;
    expect(pages.pages.map((p) => [p.pdfPage, p.printedPage, p.lines.map((l) => `${l.lineNo} ${l.rawText}`)])).toEqual([
      [2, 7, ["1 Q. Where were you?", "2 ", "3 A. At home."]],
      [3, 8, ["1 Q And after that?", "3 A Nothing."]],
    ]);
    expect(pages.inferredPages).toEqual([]);
    expect(pages.pages[1].unnumbered).toEqual(["NOT FOR COUNSEL'S EYES ONLY", "Jenny the Court Reporter"]);
    expect(pages.warnings.join(" ")).toMatch(/PDF page 1 has no line numbers.*Line numbers skip on page 8.*2 rows have no line number.*removed from 2 lines/);
  });

  it("numbers rows that exactly fill a gap in the printed numbers, and flags them; never an uneven gap", () => {
    const read = (between: string[]) => readNumberedPdfPages([page(row(750, ["8", 570]), row(700, ["18", 20], ["DOJ conversations that we had had,", 50]), ...between.map((t, k) => row(680 - k * 20, [t, 50])), row(600, ["21", 20], ["A He was.", 50]))], LAYOUT)!;
    const filled = read(["people. But I could identify them.", "Q Was he present?"]);
    expect(filled.pages[0].lines.map((l) => `${l.lineNo} ${l.rawText}`)).toEqual(["18 DOJ conversations that we had had,", "19 people. But I could identify them.", "20 Q Was he present?", "21 A He was."]);
    expect(filled.pages[0].unnumbered).toEqual([]);
    expect(filled.warnings.join(" ")).toMatch(/Line 8:19, 8:20 have no number in the PDF's text/);
    const uneven = read(["people. But I could identify them."]);
    expect(uneven.pages[0].lines.map((l) => l.lineNo)).toEqual([18, 21]);
    expect(uneven.pages[0].unnumbered).toEqual(["people. But I could identify them."]);
  });

  it("infers and flags a page number that isn't printed", () => {
    const pages = readNumberedPdfPages([page(row(750, ["4", 570]), row(700, ["1", 20], ["A. Yes.", 50])), page(row(700, ["1", 20], ["Q. Why?", 50]))], LAYOUT)!;
    expect(pages.pages.map((p) => p.printedPage)).toEqual([4, 5]);
    expect(pages.inferredPages).toEqual([2]);
  });

  it("leaves a PDF whose rows don't carry line numbers to the other readers", () => {
    expect(readNumberedPdfPages([page(row(700, ["Q. Did you approve it?", 72]), row(680, ["A. Yes.", 72]))], LAYOUT)).toBeNull();
    expect(readNumberedPdfPages([page(row(700, ["1", 20], ["Q. One numbered row", 50]), row(680, ["and then", 72]), row(660, ["prose", 72]), row(640, ["without", 72]))], LAYOUT)).toBeNull();
  });
});

const NO_OCR = async () => ({ available: false as const, reason: "off" });
const renderings = [
  { pdf: "data/raw/transcripts/readback/sample-full.pdf", ground: "tests/fixtures/transcripts/readback-ascii.json", lines: 400 },
  { pdf: "data/raw/transcripts/legalinformatics/li-sample.pdf", ground: "tests/fixtures/transcripts/legalinformatics-ascii.json", lines: 88 },
];
describe("genuine PDF renderings against the hand-verified ground truth of their transcripts", () => {
  for (const r of renderings) {
    it.skipIf(!existsSync(r.pdf))(`${r.pdf} reads ready from its text layer, every checked line at its page:line`, async () => {
      const read = await readDeposition(new Uint8Array(readFileSync(r.pdf)), undefined, NO_OCR);
      expect(read.validation).toMatchObject({ status: "ready", layout: "text-numbered-v1" });
      const lines = read.pdf!.pages.flatMap((p) => p.lines);
      expect(lines).toHaveLength(r.lines);
      const at = new Map(lines.map((l) => [`${l.printedPage}:${l.lineNo}`, l.rawText.replace(/\s+/g, " ")]));
      const ground = (JSON.parse(readFileSync(r.ground, "utf8")) as { lines: { ref: string; text: string }[] }).lines;
      // The PDF of Dow v. Nova renders its cover page without line numbers, so page 1 isn't in it.
      for (const g of ground.filter((g) => at.has(`${g.ref.split(":")[0]}:1`))) expect(at.get(g.ref), g.ref).toBe(g.text.replace(/\s+/g, " "));
    }, 60_000);
  }
});
