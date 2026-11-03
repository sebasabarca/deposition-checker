// PDFs with a text layer but no line-number gutter: read by physical line, never rejected for that
// alone, and never renumbered when they do carry printed line numbers.

import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { PARSER_VERSION, PDF_PHYSICAL_V1, PHYSICAL_LINES_WARNING, readDeposition, readPhysicalPages, readPhysicalPdf } from "../../server/src/ingest";

const NO_OCR = async () => ({ available: false as const, reason: "OCR is off in tests" });

// A PDF drawn from rows of text, one array per page, with no line-number gutter unless the rows carry one.
function pdfOf(pages: string[][]): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    for (const rows of pages) {
      doc.addPage();
      rows.forEach((row, i) => doc.font("Courier").fontSize(11).text(row, 72, 72 + i * 20, { lineBreak: false }));
    }
    doc.end();
  });
}

const VOSS = [
  ["DEPOSITION OF MARA VOSS", "January 14, 2025 | Page 1", "Q. Did you approve the Beacon release on March 3?", "A. I approved the release candidate,", "not the production release.", "Q. Was the export enabled at that time?", "[Page 1 ends]"],
  ["January 14, 2025 | Page 2", "A. No. The export flag was disabled.", "Q. Who was present?", "A. Jordan Pike and I.", "[Page 2 ends]"],
];

describe("physical lines (pure)", () => {
  it("numbers each page's rows within that page and keeps running headers and footers out", () => {
    const { pages, running } = readPhysicalPages(VOSS);
    expect(running).toBe(4);
    expect(pages[0].footer).toEqual(["January 14, 2025 | Page 1", "[Page 1 ends]"]);
    expect(pages.map((p) => p.lines.map((l) => `${l.printedPage}:${l.lineNo} ${l.rawText}`))).toEqual([
      ["1:1 DEPOSITION OF MARA VOSS", "1:2 Q. Did you approve the Beacon release on March 3?", "1:3 A. I approved the release candidate,", "1:4 not the production release.", "1:5 Q. Was the export enabled at that time?"],
      ["2:1 A. No. The export flag was disabled.", "2:2 Q. Who was present?", "2:3 A. Jordan Pike and I."],
    ]);
  });

  it("never takes a repeated answer for a header", () => {
    const { pages } = readPhysicalPages([["A. Yes.", "Q. Next?"], ["A. Yes.", "Q. And?"]]);
    expect(pages.flatMap((p) => p.lines.map((l) => l.rawText))).toContain("A. Yes.");
    expect(pages.every((p) => p.footer.length === 0)).toBe(true);
  });

  it("keeps a wrapped answer as its own rows and joins a question to an answer across a page break", () => {
    const read = readPhysicalPdf(VOSS, "Mara Voss")!;
    expect(read.validation).toMatchObject({ status: "ready", layout: PDF_PHYSICAL_V1.name, counts: { text: 2, blank: 0, needs_ocr: 0, failed: 0 } });
    expect(read.validation.warnings).toContain(PHYSICAL_LINES_WARNING);
    const lines = read.pdf.pages.flatMap((p) => p.lines);
    const exchange = read.exchanges!.exchanges.find((x) => x.lines.some((l) => lines[l.index].rawText.startsWith("Q. Was the export")))!;
    expect(exchange.lines.map((l) => [l.role, `${lines[l.index].printedPage}:${lines[l.index].lineNo}`])).toEqual([["question", "1:5"], ["answer", "2:1"]]);
    const wrapped = read.exchanges!.exchanges.find((x) => x.lines.some((l) => lines[l.index].rawText.startsWith("Q. Did you approve")))!;
    expect(wrapped.lines.map((l) => l.role)).toEqual(["unknown", "question", "answer", "answer"]); // the title row has no speaker
  });

  it("leaves rows that start with line numbers to the gutter reader: printed numbers take priority", () => {
    expect(readPhysicalPdf([["1 Q. Did you approve it?", "2 A. Yes.", "3 Q. When?", "4 A. In March."]])).toBeNull();
  });

  it("counts a page with no text layer as needing OCR, so the deposition needs review", () => {
    const read = readPhysicalPdf([VOSS[0], []])!;
    expect(read.validation).toMatchObject({ status: "needs_review", needsOcrPages: [2] });
    expect(read.exchanges).toBeNull();
  });
});

describe("gutterless PDFs end to end", () => {
  it("imports a text PDF without a line-number gutter instead of rejecting it", async () => {
    const read = await readDeposition(await pdfOf(VOSS), undefined, NO_OCR, "Mara Voss");
    expect(read.parserVersion).toBe(PARSER_VERSION);
    expect(read.validation).toMatchObject({ status: "ready", layout: "pdf-physical-v1" });
    expect(read.validation.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/couldn't read the page images/), PHYSICAL_LINES_WARNING]));
    expect(read.pdf!.pages[1].lines[0]).toMatchObject({ printedPage: 2, lineNo: 1, rawText: "A. No. The export flag was disabled." });
  });

  it("reads a PDF whose rows carry printed line numbers in another layout by those numbers, never by physical line", async () => {
    const read = await readDeposition(await pdfOf([["1 Q. Did you approve it?", "2 A. Yes.", "3 Q. When?", "4 A. In March."]]), undefined, NO_OCR);
    expect(read.validation).toMatchObject({ status: "ready", layout: "text-numbered-v1" });
    expect(read.pdf!.pages[0].lines.map((l) => [l.lineNo, l.rawText])).toEqual([[1, "Q. Did you approve it?"], [2, "A. Yes."], [3, "Q. When?"], [4, "A. In March."]]);
  });

  it("still fails clearly on a PDF with no text layer when OCR can't run", async () => {
    const read = await readDeposition(await pdfOf([[]]), undefined, NO_OCR);
    expect(read.validation.status).toBe("unsupported");
    expect(read.validation.reasons).toContain("OCR is off in tests");
  });
});
