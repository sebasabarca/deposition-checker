import { describe, it, expect } from "vitest";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import { joinRow, readPageItems, type PageExtraction, type TextItem } from "../../server/src/ingest/pdf";
import { validateDeposition, validatePage } from "../../server/src/ingest/validate";

const item = (str: string, x: number, y: number, width = str.length * 5): TextItem => ({ str, x, y, width });
const yOf = (line: number) => LAYOUT.firstLineY - (line - 1) * LAYOUT.lineSpacing;

// A page in the validated layout: printed page header, numbered lines, and the DOJ footer.
function page(pdfPage: number, printedPage: number | null, lines: number[], extra: TextItem[] = []): TextItem[] {
  const items = [item("Ellison 01-20-04", 72, 75), item(String(pdfPage), 534.8, 75), ...extra];
  if (printedPage !== null) items.push(item(String(printedPage).padStart(5, "0"), 72, 710.3));
  for (const n of lines) items.push(item(`${n} testimony on line ${n}`, 81, yOf(n)));
  return items;
}
const read = (pdfPage: number, items: TextItem[]) => readPageItems(pdfPage, items, LAYOUT);
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("readPageItems", () => {
  it("inserts a space only where items are separated by a gap", () => {
    expect(joinRow([item("15", 81, 0, 10), item("Q. Yes.", 112.5, 0)], LAYOUT)).toBe("15 Q. Yes.");
    expect(joinRow([item("data", 100, 0, 20), item("base", 120, 0)], LAYOUT)).toBe("database");
  });

  it("reads the printed page, footer, line numbers, positions and indents", () => {
    const result = read(2, [
      item("Ellison 01-20-04", 72, 75),
      item("2", 534.8, 75),
      item("00009", 72, 710.3),
      item("1", 84, 697.5, 5),
      item("Q. All right.", 110.3, 697.5),
      item("2 will point out to you", 84, 675),
    ]);
    expect(result).toEqual({
      pdfPage: 2,
      hasText: true,
      printedPage: 9,
      footer: ["Ellison 01-20-04 2"],
      unnumbered: [],
      lines: [
        { pdfPage: 2, printedPage: 9, lineNo: 1, lineFromPosition: 1, indentX: 110.3, rawText: "Q. All right." },
        { pdfPage: 2, printedPage: 9, lineNo: 2, lineFromPosition: 2, indentX: null, rawText: "will point out to you" },
      ],
    });
  });

  it("marks a page with no text items as having no text layer", () => {
    expect(read(1, [item("   ", 72, 75)]).hasText).toBe(false);
  });
});

describe("validatePage", () => {
  const validate = (p: PageExtraction, previous: number | null = null) => validatePage(p, previous, LAYOUT);

  it("accepts a page that matches the layout", () => {
    const result = validate(read(1, page(1, 8, lines(1, 22))));
    expect(result).toEqual({ pdfPage: 1, printedPage: 8, status: "text", lineCount: 22, failures: [] });
  });

  it("accepts a redacted page whose remaining lines start partway down", () => {
    expect(validate(read(1, page(1, 8, lines(14, 22)))).status).toBe("text");
  });

  it("calls a page with only a footer blank", () => {
    expect(validate(read(64, page(64, null, []))).status).toBe("blank");
  });

  it("calls a page with no text layer needs_ocr", () => {
    expect(validate(read(3, [])).status).toBe("needs_ocr");
  });

  it("fails a line whose number doesn't match its position", () => {
    const items = page(1, 8, [1, 2]);
    items.push(item("3 this row sits in slot 4", 81, yOf(4)));
    const result = validate(read(1, items));
    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([{ reason: "line_position_mismatch", detail: "line 3 sits in slot 4" }]);
  });

  it("fails a page with no printed page number", () => {
    const result = validate(read(1, page(1, null, lines(1, 5))));
    expect(result.failures.map((f) => f.reason)).toEqual(["printed_page_missing"]);
  });

  it("fails printed pages that repeat or go backwards", () => {
    expect(validate(read(2, page(2, 8, [1])), 8).failures.map((f) => f.reason)).toEqual(["printed_page_not_increasing"]);
    expect(validate(read(2, page(2, 7, [1])), 8).failures.map((f) => f.reason)).toEqual(["printed_page_not_increasing"]);
  });

  it("fails rows without a line number instead of dropping them", () => {
    const result = validate(read(1, page(1, 8, [1], [item("a heading with no number", 120, yOf(3))])));
    expect(result.failures).toEqual([{ reason: "unnumbered_row", detail: "a heading with no number" }]);
  });

  it("fails line numbers beyond the layout's 22 lines", () => {
    const result = validate(read(1, page(1, 8, [1], [item("25 an extra line", 81, 140)])));
    expect(result.failures.map((f) => f.reason)).toContain("line_out_of_range");
  });

  it("fails duplicate line numbers", () => {
    const result = validate(read(1, page(1, 8, [1], [item("1 printed twice", 81, yOf(1) - 0.2 - LAYOUT.rowTolerance * 2)])));
    expect(result.failures.map((f) => f.reason)).toContain("line_duplicate");
  });

  it("fails line numbers that go backwards down the page", () => {
    const items = page(1, 8, [5]);
    items.push(item("3 this row is printed below line 5", 81, yOf(6)));
    const reasons = validate(read(1, items)).failures.map((f) => f.reason);
    expect(reasons).toContain("line_out_of_order");
  });

  it("order-checks the printed number on a blank page", () => {
    expect(validate(read(2, page(2, 50, [])), 98)).toEqual({
      pdfPage: 2,
      printedPage: 50,
      status: "failed",
      lineCount: 0,
      failures: [{ reason: "printed_page_not_increasing", detail: "p.50 follows p.98" }],
    });
    expect(validate(read(2, page(2, 99, [])), 98).status).toBe("blank");
  });

  it("fails text in the footer zone that isn't the expected footer", () => {
    const result = validate(read(1, page(1, 8, [1], [item("23 testimony printed below the last line", 81, 90)])));
    expect(result.failures).toEqual([{ reason: "unexpected_footer", detail: "23 testimony printed below the last line" }]);
  });

  it("fails a footer whose page number isn't this page", () => {
    const items = page(5, 8, [1]).filter((i) => i.str !== "5");
    items.push(item("9", 534.8, 75));
    expect(validate(read(5, items)).failures).toEqual([{ reason: "footer_page_mismatch", detail: "footer says 9" }]);
  });
});

describe("validateDeposition", () => {
  const depo = (...pages: TextItem[][]) => validateDeposition(pages.map((items, i) => read(i + 1, items)), LAYOUT);

  it("is ready when every page is text or blank", () => {
    const result = depo(page(1, 8, lines(1, 22)), page(2, null, []), page(3, 12, lines(1, 22)));
    expect(result.status).toBe("ready");
    expect(result.counts).toEqual({ text: 2, blank: 1, needs_ocr: 0, failed: 0 });
    expect(result.blankPages).toEqual([2]);
    expect(result.reasons).toEqual([]);
    expect(result.pages.map((p) => p.status)).toEqual(["text", "blank", "text"]);
  });

  it("needs review when some pages have no text layer", () => {
    const result = depo(page(1, 8, lines(1, 22)), []);
    expect(result.status).toBe("needs_review");
    expect(result.needsOcrPages).toEqual([2]);
    expect(result.reasons).toEqual(["1 of 2 pages have no text layer (OCR is not supported)"]);
  });

  it("needs review when some pages fail validation", () => {
    const result = depo(page(1, 8, lines(1, 22)), page(2, 8, lines(1, 22)));
    expect(result.status).toBe("needs_review");
    expect(result.failedPages).toEqual([2]);
  });

  it("is unsupported when no page has a text layer", () => {
    const result = depo([], [], []);
    expect(result.status).toBe("unsupported");
    expect(result.counts.needs_ocr).toBe(3);
  });

  it("is unsupported when no page matches the layout", () => {
    const other = [item("Page 1", 300, 760), item("Some other publisher's layout", 72, 600)];
    const result = depo(other, other);
    expect(result.status).toBe("unsupported");
    expect(result.reasons).toEqual(["2 of 2 pages do not match layout ellison-doj-v1"]);
  });

  it("is unsupported when the PDF has no pages", () => {
    expect(depo().status).toBe("unsupported");
  });

  it("gives a reason when every page is blank", () => {
    const result = depo(page(1, null, []), page(2, null, []));
    expect(result.status).toBe("unsupported");
    expect(result.reasons).toEqual(["no page contains transcript lines"]);
  });

  it("finding 3: fails consecutive numbered blank pages that go backwards", () => {
    const result = depo(page(1, 100, lines(1, 22)), page(2, 102, []), page(3, 101, []), page(4, 103, lines(1, 22)));
    expect(result.status).toBe("needs_review");
    expect(result.failedPages).toEqual([3]);
    expect(result.pages[2].failures).toEqual([{ reason: "printed_page_not_increasing", detail: "p.101 follows p.102" }]);
  });

  it("finding 3: fails consecutive numbered blank pages that repeat a number", () => {
    const result = depo(page(1, 100, lines(1, 22)), page(2, 101, []), page(3, 101, []), page(4, 103, lines(1, 22)));
    expect(result.status).toBe("needs_review");
    expect(result.failedPages).toEqual([3]);
  });

  it("finding 3: keeps numbered blank pages in order ready, and blank distinct from needs_ocr", () => {
    const result = depo(page(1, 100, lines(1, 22)), page(2, 101, []), page(3, 102, []), [], page(5, 104, lines(1, 22)));
    expect(result.pages.map((p) => p.status)).toEqual(["text", "blank", "blank", "needs_ocr", "text"]);
    expect(result.blankPages).toEqual([2, 3]);
    expect(result.needsOcrPages).toEqual([4]);
  });

  it("blames a misnumbered blank page, not the page after it", () => {
    const result = depo(page(1, 98, lines(1, 22)), page(2, 500, []), page(3, 114, lines(14, 22)));
    expect(result.failedPages).toEqual([2]);
    expect(result.pages[2].status).toBe("text");
  });

  it("checks page order against the last valid page, skipping blank ones", () => {
    const result = depo(page(1, 98, lines(1, 22)), page(2, null, []), page(3, 114, lines(14, 22)));
    expect(result.status).toBe("ready");
  });
});
