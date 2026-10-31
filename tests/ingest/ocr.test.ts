import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inferPageNumbers, parseTsv, readDeposition, readOcrPage, type OcrPage, type OcrReader, type OcrWord } from "../../server/src/ingest";
import { attributeSpeakers } from "../../server/src/ingest/exchanges";
import { fitGrid, SCANNED_25_V1 } from "../../server/src/ingest/ocr";

const SPACING = 96;
const y = (line: number) => 500 + (line - 1) * SPACING;
const word = (text: string, left: number, top: number, confidence = 96): OcrWord => ({ text, left, top, width: text.length * 20, height: 30, confidence });
// A page with gutter digits, the given rows, and a page number at the bottom right. `shift` moves the
// whole scan, as paper feeding does.
function page(rows: Record<number, string>, { shift = 0, printed = "498", skip = [] as number[] } = {}): OcrWord[] {
  const out: OcrWord[] = [];
  for (let n = 1; n <= 25; n++) {
    if (!skip.includes(n)) out.push(word(String(n), 300 + shift, y(n)));
    if (rows[n]) rows[n].split(" ").forEach((t, i) => out.push(word(t, 640 + shift + i * 120, y(n))));
  }
  if (printed) out.push(word(printed, 1900, y(27)));
  out.push(word("REPORTERS", 450, y(28)), word("888", 900, y(28)));
  return out;
}

describe("parseTsv", () => {
  it("keeps words with their box and confidence, and skips structure rows", () => {
    const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t2550\t3300\t-1\t\n5\t1\t1\t1\t1\t1\t291\t2379\t52\t30\t96.2\t20\n";
    expect(parseTsv(tsv)).toEqual([{ left: 291, top: 2379, width: 52, height: 30, confidence: 96.2, text: "20" }]);
  });
});

describe("fitGrid", () => {
  it("survives misread digits", () => {
    const digits = Array.from({ length: 14 }, (_, i) => ({ line: i + 1, y: y(i + 1) }));
    digits[3].line = 9;
    expect(fitGrid(digits)).toEqual({ first: 500, spacing: SPACING });
  });
  it("needs enough digits", () => {
    expect(fitGrid([{ line: 1, y: 1 }, { line: 2, y: 2 }])).toBeNull();
  });
});

describe("readOcrPage", () => {
  it("reads lines at their numbers, with the page number and confidence", () => {
    const p = readOcrPage(2, page({ 23: "A I don't consider", 24: "could say" }), false);
    expect(p.printedPage).toBe(498);
    expect(p.lines.map((l) => [l.lineNo, l.rawText, l.ocrConfidence])).toEqual([[23, "A I don't consider", 96], [24, "could say", 96]]);
  });
  it("gives the same result on a page shifted by the scanner", () => {
    const [a, b] = [readOcrPage(2, page({ 23: "A Yes" }), false), readOcrPage(2, page({ 23: "A Yes" }, { shift: 120 }), false)];
    expect(b.lines[0]).toMatchObject({ lineNo: a.lines[0].lineNo, indentX: a.lines[0].indentX, rawText: "A Yes" });
  });
  it("never takes the page number from the footer's phone number", () => {
    expect(readOcrPage(2, page({ 1: "text" }, { printed: "" }), false).printedPage).toBeNull();
  });
  it("places a line by position when its digit is unreadable", () => {
    expect(readOcrPage(2, page({ 5: "words" }, { skip: [5] }), false).lines[0]).toMatchObject({ lineNo: 5, lineFromPosition: 5 });
  });
  it("a digit disagreeing with its position stays visible to validation", () => {
    const words = page({ 5: "words" }, { skip: [5] });
    words.push(word("9", 300, y(5)));
    expect(readOcrPage(2, words, false).lines[0]).toMatchObject({ lineNo: 9, lineFromPosition: 5 });
  });
  it("lists handwriting between lines instead of merging it into testimony", () => {
    const words = page({ 18: "Government Exhibit" });
    words.push(word("Deposition", 1000, y(18) - SPACING / 2));
    const p = readOcrPage(2, words, false);
    expect(p.lines.map((l) => l.rawText)).toEqual(["Government Exhibit"]);
    expect(p.ocr.annotations).toEqual(["Deposition"]);
  });
  it("counts a speck as noise", () => {
    const words = page({ 14: "words" });
    words.push(word(",", 1500, y(15), 20));
    const p = readOcrPage(2, words, false);
    expect(p.ocr.noiseWords).toBe(1);
    expect(p.lines).toHaveLength(1);
  });
  it("treats marker-indented rows as turns and a margin row starting with A as continuation", () => {
    const rows = readOcrPage(2, page({ 2: "A Yes" }), false).lines;
    expect(rows[0].indentX).not.toBeNull();
    const margin = [...page({}), word("A", 435, y(3)), word("company", 500, y(3))];
    expect(readOcrPage(2, margin, false).lines[0].indentX).toBeNull();
    const marked = attributeSpeakers([{ ...rows[0], printedPage: 498 }], SCANNED_25_V1);
    expect(marked[0].role).toBe("witness");
  });
  it("corrects a misread marker by its column, so the witness's words stay the witness's", () => {
    const words = [...page({}), word("AL", 640, y(22)), word("If", 760, y(22)), word("top", 880, y(22))];
    const p = readOcrPage(2, words, false);
    expect(p.lines[0].rawText).toBe("A. If top");
    expect(p.ocr.markersCorrected).toBe(1);
    expect(attributeSpeakers(p.lines, SCANNED_25_V1)[0].role).toBe("witness");
  });
  it("keeps a marker that was read correctly exactly as printed", () => {
    const p = readOcrPage(2, page({ 2: "A Yes", 3: "Q. Next" }), false);
    expect(p.lines.map((l) => l.rawText)).toEqual(["A Yes", "Q. Next"]);
    expect(p.ocr.markersCorrected).toBe(0);
  });
  it("leaves real words alone, in the marker column and elsewhere", () => {
    const words = [...page({}), word("AI", 435, y(3)), word("systems", 560, y(3)), word("Apple", 640, y(4)), word("said", 800, y(4))];
    expect(readOcrPage(2, words, false).lines.map((l) => l.rawText)).toEqual(["AI systems", "Apple said"]);
  });
  it("doesn't store a gutter digit as testimony", () => {
    const p = readOcrPage(2, [...page({ 1: "words" }), word("23.", 640, y(23), 41)], false);
    expect(p.lines.map((l) => l.lineNo)).toEqual([1]);
  });
  it("a first page with no printed number is a cover, with no lines; a later one isn't", () => {
    const cover = readOcrPage(1, page({ 1: "IN THE COURT" }, { printed: "" }), true);
    expect(cover).toMatchObject({ lines: [], ocr: { coverPage: true } });
    expect(readOcrPage(5, page({ 1: "words" }, { printed: "" }), false).ocr.coverPage).toBe(false);
  });
  it("can't place a page without a digit column", () => {
    const p = readOcrPage(3, [word("loose", 900, 900), word("text", 1000, 900)], false);
    expect(p.lines).toEqual([]);
    expect(p.unnumbered).toEqual(["loose", "text"]);
  });
  it("a blank scan has no text", () => {
    expect(readOcrPage(1, [word(",", 10, 10, 10)], true).hasText).toBe(false);
  });
});

describe("inferPageNumbers", () => {
  const ocrPage = (pdfPage: number, printedPage: number | null): OcrPage => ({ ...readOcrPage(pdfPage, page({ 1: "words" }, { printed: "500" }), false), printedPage });
  it("fills or corrects a number only when its neighbours leave one value, and reports it", () => {
    const pages = [ocrPage(1, 602), ocrPage(2, 69), ocrPage(3, 604)];
    expect(inferPageNumbers(pages)).toEqual([2]);
    expect(pages[1].printedPage).toBe(603);
    expect(pages[1].lines[0].printedPage).toBe(603);
  });
  it("leaves a wider gap alone, since excerpts skip pages", () => {
    const pages = [ocrPage(1, 501), ocrPage(2, null), ocrPage(3, 581)];
    expect(inferPageNumbers(pages)).toEqual([]);
    expect(pages[1].printedPage).toBeNull();
  });
  it("leaves a correct number alone", () => {
    expect(inferPageNumbers([ocrPage(1, 1), ocrPage(2, 2), ocrPage(3, 3)])).toEqual([]);
  });
});

describe("readDeposition on a scan", () => {
  const scan = (pages: OcrPage[]): OcrReader => async () => ({ available: true, engine: "test", pages });
  const gates = "data/raw/gates/gates8a.pdf";
  const imageOnly = existsSync(gates) ? new Uint8Array(readFileSync(gates)) : null;

  it.skipIf(!imageOnly)("stays needs_ocr with the reason when the tools are missing", async () => {
    const r = await readDeposition(imageOnly!, undefined, async () => ({ available: false, reason: "OCR tools aren't installed on this server" }));
    expect(r.validation.counts.needs_ocr).toBeGreaterThan(0);
    expect(r.validation.reasons.join()).toContain("aren't installed");
    expect(r.exchanges).toBeNull();
  });

  it.skipIf(!imageOnly)("a page with low confidence fails, and no exchanges are built", async () => {
    const low = readOcrPage(2, page({ 1: "A smudged" }).map((w) => ({ ...w, confidence: 50 })), false);
    const r = await readDeposition(imageOnly!, undefined, scan([low]));
    expect(r.validation.pages[0].failures.map((f) => f.reason)).toContain("low_ocr_confidence");
    expect(r.exchanges).toBeNull();
  });

  it.skipIf(!imageOnly)("a clean scan is ready, says it was OCR, and keeps confidence on its lines", async () => {
    const r = await readDeposition(imageOnly!, undefined, scan([readOcrPage(2, page({ 1: "Q Did you?", 2: "A Yes." }), false)]));
    expect(r.validation).toMatchObject({ status: "ready", layout: "scanned-25-v1", ocr: { engine: "test", meanConfidence: 96 } });
    expect(r.exchanges?.parts.length).toBe(1);
  });

  const tools = (() => { try { execSync("tesseract --version && pdftoppm -v", { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!imageOnly || !tools)("reads a real scan end to end", async () => {
    const r = await readDeposition(imageOnly!);
    expect(r.validation.status).toBe("ready");
    expect(r.validation.ocr?.coverPages).toEqual([1]);
    const lines = r.pdf!.pages.flatMap((p) => p.lines);
    expect(lines.find((l) => l.printedPage === 498 && l.lineNo === 20)?.rawText).toBe("issue of whether or not browsers are a separate");
  }, 60_000);
});
