import { describe, it, expect } from "vitest";
import { readHtmlTranscript } from "../scripts/spike/html";
import { joinRow, readPageItems, type TextItem } from "../scripts/spike/pdf";
import { categorize, compareLines } from "../scripts/spike/compare";
import { buildExchanges, markPdfLine, type MarkedLine } from "../scripts/spike/exchanges";

const row = (n: string, text: string) =>
  `<tr valign="top"><td align="right">${n}</td><td>${text}</td></tr>`;

describe("readHtmlTranscript", () => {
  it("reads page markers and numbered lines, skipping redacted rows", () => {
    const html = [
      `<tr valign="top"><td colspan="2">00008</td></tr>`,
      row("&nbsp;", "&nbsp;"),
      row("14", "BY MR. SCOTT:"),
      row("15", "&nbsp;&nbsp;&nbsp;Q. Isn&#39;t that &quot;Exhibit 1&quot;?"),
      `<tr valign="top"><td colspan="2">00009</td></tr>`,
      row("1", "A. Yes."),
    ].join("");
    const result = readHtmlTranscript(html);
    expect(result.pages).toEqual([8, 9]);
    expect(result.anomalies).toEqual([]);
    expect(result.lines).toEqual([
      { page: 8, line: 14, text: "BY MR. SCOTT:" },
      { page: 8, line: 15, text: `   Q. Isn't that "Exhibit 1"?` },
      { page: 9, line: 1, text: "A. Yes." },
    ]);
  });

  it("reports text without a line number instead of dropping it", () => {
    const html = `<tr><td colspan="2">00010</td></tr>` + row("&nbsp;", "stray text");
    expect(readHtmlTranscript(html).anomalies).toEqual([{ page: 10, row: "stray text" }]);
  });
});

describe("PDF page reading", () => {
  const item = (str: string, x: number, y: number, width = str.length * 5): TextItem => ({ str, x, y, width });

  it("inserts a space only where items are separated by a gap", () => {
    expect(joinRow([item("15", 81, 0, 10), item("Q. Yes.", 112.5, 0)])).toBe("15 Q. Yes.");
    expect(joinRow([item("data", 100, 0, 20), item("base", 120, 0)])).toBe("database");
  });

  it("strips the printed page header and footer, and reads line numbers and indents", () => {
    const { lines, report } = readPageItems(2, [
      item("Ellison 01-20-04", 72, 75),
      item("2", 534.8, 75),
      item("00009", 72, 710.3),
      item("1", 84, 697.5, 5),
      item("Q. All right.", 110.3, 697.5),
      item("2 will point out to you", 84, 675),
    ]);
    expect(report.printedPage).toBe(9);
    expect(report.stripped).toHaveLength(2);
    expect(lines).toEqual([
      { pdfPage: 2, printedPage: 9, line: 1, lineFromPosition: 1, indentX: 110.3, text: "Q. All right." },
      { pdfPage: 2, printedPage: 9, line: 2, lineFromPosition: 2, indentX: null, text: "will point out to you" },
    ]);
  });
});

describe("compareLines", () => {
  it("counts exact matches and categorizes every difference", () => {
    const html = [
      { page: 8, line: 1, text: "   A. Yes." },
      { page: 8, line: 2, text: "A.\tSure." },
      { page: 8, line: 3, text: "would rum to page 57" },
      { page: 8, line: 4, text: "missing" },
    ];
    const pdf = [
      { pdfPage: 1, printedPage: 8, line: 1, lineFromPosition: 1, indentX: 112, text: "A. Yes." },
      { pdfPage: 1, printedPage: 8, line: 2, lineFromPosition: 2, indentX: 112, text: "A. Sure." },
      { pdfPage: 1, printedPage: 8, line: 3, lineFromPosition: 3, indentX: null, text: "would turn to page 57" },
      { pdfPage: 1, printedPage: 8, line: 5, lineFromPosition: 5, indentX: null, text: "extra" },
    ];
    const result = compareLines(html, pdf, [8], [8]);
    expect(result.exact).toBe(1);
    expect(result.byCategory).toEqual({
      missing_in_pdf: 1,
      extra_in_pdf: 1,
      internal_whitespace: 1,
      typography: 0,
      text: 1,
    });
  });

  it("does not treat punctuation or case differences as whitespace", () => {
    expect(categorize("A. I do", "A. I do.")).toBe("text");
    expect(categorize("you--I", "you -- I")).toBe("text");
    expect(categorize("It’s", "It's")).toBe("typography");
  });
});

describe("markPdfLine", () => {
  it("uses the indent position to tell answers from paragraphs", () => {
    expect(markPdfLine("A They're not big enough.", 113)).toBe("A");
    expect(markPdfLine("A couple of them I did want to ask you about.", 122)).toBe(null);
    expect(markPdfLine("Q. Yes?", 110)).toBe("Q");
    expect(markPdfLine("be the deposition of", null)).toBe(null);
  });

  it("recognizes colloquy, a resumed attorney question, and a new examiner", () => {
    expect(markPdfLine("MR. RILL: I'm going to object to the nature of", 122)).toBe("speaker");
    expect(markPdfLine("MR. SCOTT: Q. Has any work been done at this", 122)).toBe("Q");
    expect(markPdfLine("THE WITNESS: They are probably slightly", 125)).toBe("A");
    expect(markPdfLine('MR. WALL: "The market" defined as what?', 122)).toBe("speaker");
    expect(markPdfLine("(Marked Deposition Exhibit No. 17)", 122)).toBe("parenthetical");
    expect(markPdfLine("BY MR. SCOTT:", null)).toBe("examiner");
  });
});

describe("buildExchanges", () => {
  const l = (page: number, line: number, text: string, turn: MarkedLine["turn"]): MarkedLine => ({ page, line, text, turn });

  it("keeps an exchange together across a page break, with its objection", () => {
    const lines = [
      l(1, 1, "Q. What did it cost?", "Q"),
      l(1, 2, "MR. RILL: Objection.", "speaker"),
      l(1, 3, "A. Five times more", "A"),
      l(2, 1, "than the suite.", null),
      l(2, 2, "Q. Why?", "Q"),
      l(2, 3, "A. Scale.", "A"),
    ];
    const [first, second] = buildExchanges(lines, "T");
    expect(first.start).toEqual({ page: 1, line: 1 });
    expect(first.end).toEqual({ page: 2, line: 1 });
    expect(first.pages).toBe(2);
    expect(first.turns.map((t) => t.marker)).toEqual(["Q", "speaker", "A"]);
    expect(first.question).toBe("What did it cost?");
    expect(first.answer).toBe("Five times more than the suite.");
    expect(second.question).toBe("Why?");
    expect(second.answer).toBe("Scale.");
  });

  it("never joins a question and an answer across a redaction gap", () => {
    const lines = [
      l(5, 1, "Q. What type of things?", "Q"),
      l(5, 2, "filler", null),
      l(5, 3, "end", null),
      l(5, 9, "but the features we lack", null),
      l(5, 10, "A. None.", "A"),
    ];
    const [before, after] = buildExchanges(lines, "T");
    expect(before.flags).toEqual(["ends_at_gap", "no_answer"]);
    expect(after.flags).toEqual(["starts_mid_turn", "ends_at_gap", "no_question"]);
  });

  it("treats a page that ends early as a gap", () => {
    // Full pages hold 3 lines. Page 1 is full, so 1:3 -> 2:1 is contiguous.
    // Page 2 stops at line 2 (line 3 redacted), so 2:2 -> 3:1 is a gap.
    const lines = [
      l(1, 1, "Q. One?", "Q"),
      l(1, 2, "A. Yes.", "A"),
      l(1, 3, "Q. Two?", "Q"),
      l(2, 1, "A. No.", "A"),
      l(2, 2, "Q. Three?", "Q"),
      l(3, 1, "A. Maybe.", "A"),
    ];
    expect(buildExchanges(lines, "T").map((e) => [e.question, e.answer, e.flags])).toEqual([
      ["One?", "Yes.", []],
      ["Two?", "No.", []],
      ["Three?", "", ["ends_at_gap", "no_answer"]],
      ["", "Maybe.", ["ends_at_gap", "no_question"]],
    ]);
  });

  it("keeps the witness's words during colloquy in the answer", () => {
    const [e] = buildExchanges(
      [
        l(1, 1, "Q. What is your share?", "Q"),
        l(1, 2, "A. We're definitely --", "A"),
        l(1, 3, 'MR. WALL: "The market" defined as what?', "speaker"),
        l(1, 4, "THE WITNESS: They are probably larger.", "A"),
      ],
      "T",
    );
    expect(e.turns.map((t) => t.marker)).toEqual(["Q", "A", "speaker", "A"]);
    expect(e.answer).toBe("We're definitely -- They are probably larger.");
  });

  it("labels a fragment after a redaction gap as testimony, not colloquy", () => {
    const [, fragment] = buildExchanges([l(1, 1, "Q. One?", "Q"), l(1, 5, "And it's got a Java environment in it.", null)], "T");
    expect(fragment.kind).toBe("qa");
    expect(fragment.flags).toContain("starts_mid_turn");
  });

  it("strips the attorney label from a resumed question", () => {
    const [e] = buildExchanges([l(1, 1, "MR. SCOTT: Q. Has any work been done?", "Q"), l(1, 2, "A. No.", "A")], "T");
    expect(e.question).toBe("Has any work been done?");
  });
});
