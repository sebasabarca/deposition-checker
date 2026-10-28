import { describe, it, expect } from "vitest";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import type { SourceLine } from "../../server/src/ingest/pdf";
import {
  ANSWER_OVERLAP_LINES,
  MAX_ANSWER_LINES,
  attributeSpeakers,
  buildExchangeParts,
  markLine,
} from "../../server/src/ingest/exchanges";

const TURN = 112.5; // x of a Q./A. marker
const PARA = 124.5; // x of a paragraph or colloquy indent

// A source line as extraction produces it. indentX is null for a line that continues a paragraph.
const src = (printedPage: number, lineNo: number, rawText: string, indentX: number | null = null): SourceLine => ({
  pdfPage: printedPage,
  printedPage,
  lineNo,
  lineFromPosition: lineNo,
  indentX,
  rawText,
});

// Consecutive source lines starting at page:line, wrapping to the next page after line 22.
function run(page: number, line: number, rows: [string, number | null][]): SourceLine[] {
  return rows.map(([text, indent]) => {
    const l = src(page, line, text, indent);
    if (line === LAYOUT.maxLinesPerPage) [page, line] = [page + 1, 1];
    else line++;
    return l;
  });
}

const textOf = (lines: SourceLine[], indexes: number[]) => indexes.map((i) => lines[i].rawText);

describe("markLine", () => {
  const mark = (text: string, indentX: number | null) => markLine(text, indentX, LAYOUT);

  it("tells turn markers from paragraphs by indent", () => {
    expect(mark("Q. Yes?", TURN)).toEqual({ turn: "Q", name: null });
    expect(mark("A They're not big enough.", TURN)).toEqual({ turn: "A", name: null });
    expect(mark("A couple of them I did want to ask you about.", PARA)).toEqual({ turn: null, name: null });
    expect(mark("be the deposition of", null)).toEqual({ turn: null, name: null });
  });

  it("names attorneys, the witness, colloquy speakers and a new examiner", () => {
    expect(mark("MR. SCOTT: Q. Has any work been done at this", PARA)).toEqual({ turn: "Q", name: "MR. SCOTT" });
    expect(mark("THE WITNESS: They are probably slightly", PARA)).toEqual({ turn: "A", name: null });
    expect(mark("MR. RILL: I'm going to object to the nature of", PARA)).toEqual({ turn: "colloquy", name: "MR. RILL" });
    expect(mark("(Marked Deposition Exhibit No. 17)", PARA)).toEqual({ turn: "parenthetical", name: null });
    expect(mark("BY MR. SCOTT:", null)).toEqual({ turn: "examiner", name: "MR. SCOTT" });
  });
});

describe("speaker attribution", () => {
  it("keeps every source line, in order, with a speaker", () => {
    const lines = run(10, 1, [
      ["Q. What did it cost?", TURN],
      ["over the life of the product?", null],
      ["MR. RILL: Objection.", PARA],
      ["A. Five times more.", TURN],
    ]);
    const attributed = attributeSpeakers(lines, LAYOUT);
    expect(attributed.map((l) => [l.index, l.rawText, l.role, l.speakerName])).toEqual([
      [0, "Q. What did it cost?", "attorney", null],
      [1, "over the life of the product?", "attorney", null],
      [2, "MR. RILL: Objection.", "colloquy", "MR. RILL"],
      [3, "A. Five times more.", "witness", null],
    ]);
  });

  it("marks text after a redaction gap as unknown until a speaker marker appears", () => {
    const lines = [
      ...run(48, 1, [["Q. One?", TURN]]),
      ...run(48, 8, [
        ["But in the circumstances that you are talking", PARA],
        ["about, is that a factor?", null],
        ["A. That's one factor.", TURN],
      ]),
    ];
    expect(attributeSpeakers(lines, LAYOUT).map((l) => l.role)).toEqual(["attorney", "unknown", "unknown", "witness"]);
  });
});

describe("exchanges", () => {
  it("keeps an exchange together across a page break, with its question and answer references", () => {
    const lines = run(11, 22, [
      ["Q. Who are currently your direct reports?", TURN],
      ["A. Jeff Henley's our chief financial officer; Safra", TURN],
      ["Catz is president in charge of operations.", null],
    ]);
    const { exchanges, parts } = buildExchangeParts(lines, LAYOUT);
    expect(exchanges).toHaveLength(1);
    const [part] = parts;
    expect(lines.map((l) => `${l.printedPage}:${l.lineNo}`)).toEqual(["11:22", "12:1", "12:2"]);
    expect(part.question).toEqual({ first: 0, last: 0 });
    expect(part.answer).toEqual({ first: 1, last: 2 });
    expect(part.span).toEqual({ first: 0, last: 2 });
    expect(part.questionText).toBe("Who are currently your direct reports?");
    expect(part.answerText).toBe("Jeff Henley's our chief financial officer; Safra Catz is president in charge of operations.");
  });

  it("keeps objections and interruptions in order without counting them as answer", () => {
    const lines = run(161, 2, [
      ["Q. What is your share of the market?", TURN],
      ["A. We're definitely --", TURN],
      ['MR. WALL: "The market" defined as what?', PARA],
      ["MR. SCOTT: As database products.", PARA],
      ["THE WITNESS: They are probably slightly", PARA],
      ["larger than we are on Windows.", null],
    ]);
    const [part] = buildExchangeParts(lines, LAYOUT).parts;
    expect(part.lines).toEqual([
      { index: 0, role: "question" },
      { index: 1, role: "answer" },
      { index: 2, role: "context" },
      { index: 3, role: "context" },
      { index: 4, role: "answer" },
      { index: 5, role: "answer" },
    ]);
    // The answer range's endpoints span the colloquy, but membership says lines 2-3 are not answer.
    expect(part.answer).toEqual({ first: 1, last: 5 });
    expect(part.answerLineCount).toBe(3);
    expect(part.answerText).toBe("We're definitely --\nThey are probably slightly larger than we are on Windows.");
    expect(part.dialogueText).toBe(
      [
        "Q: What is your share of the market?",
        "A: We're definitely --",
        'MR. WALL: "The market" defined as what?',
        "MR. SCOTT: As database products.",
        "A: They are probably slightly larger than we are on Windows.",
      ].join("\n"),
    );
  });

  it("keeps unknown-speaker text but never treats it as the witness's answer", () => {
    const lines = [
      ...run(33, 1, [["Q. What does it include?", TURN]]),
      ...run(33, 5, [
        ["And it's got a Java environment in it.", PARA],
        ["It has business intelligence tools.", null],
      ]),
    ];
    const { exchanges, parts } = buildExchangeParts(lines, LAYOUT);
    const fragment = parts[1];
    expect(exchanges[1].flags).toEqual(["starts_mid_turn", "ends_at_gap"]);
    expect(fragment.kind).toBe("qa");
    expect(fragment.lines).toEqual([
      { index: 1, role: "unknown" },
      { index: 2, role: "unknown" },
    ]);
    expect(fragment.answer).toBeNull();
    expect(fragment.answerText).toBe("");
    expect(fragment.questionText).toBe("");
  });

  it("never joins a question to an answer across a redaction gap", () => {
    const lines = [...run(83, 7, [["Q. What type of things?", TURN]]), ...run(83, 17, [["A. It's a matter of --", TURN]])];
    const { exchanges } = buildExchangeParts(lines, LAYOUT);
    expect(exchanges.map((e) => e.flags)).toEqual([
      ["ends_at_gap", "no_answer"],
      ["ends_at_gap", "no_question"],
    ]);
  });

  it("treats a page that ends before the last line as a redaction gap", () => {
    const lines = [...run(9, 13, [["Q. Is this your deposition?", TURN]]), ...run(10, 1, [["A. Yes.", TURN]])];
    expect(buildExchangeParts(lines, LAYOUT).exchanges).toHaveLength(2);
  });

  it("strips the attorney label from a resumed question but keeps the source line unchanged", () => {
    const lines = run(84, 6, [
      ["MR. SCOTT: Q. Has any work been done?", PARA],
      ["A. I know of no such document.", TURN],
    ]);
    const { lines: attributed, parts } = buildExchangeParts(lines, LAYOUT);
    expect(parts[0].questionText).toBe("Has any work been done?");
    expect(attributed[0].rawText).toBe("MR. SCOTT: Q. Has any work been done?");
    expect(attributed[0].speakerName).toBe("MR. SCOTT");
  });
});

describe("Codex review regressions", () => {
  it("finding 1: keeps an attorney's correction, in order and labelled, in the model-facing text", () => {
    const lines = run(20, 1, [
      ["Q. Did you approve the sale?", TURN],
      ["A. No.", TURN],
      ["MR. SCOTT: I mean the purchase.", PARA],
      ["THE WITNESS: Yes.", PARA],
    ]);
    const [part] = buildExchangeParts(lines, LAYOUT).parts;
    expect(part.dialogueText).toBe(["Q: Did you approve the sale?", "A: No.", "MR. SCOTT: I mean the purchase.", "A: Yes."].join("\n"));
    // Witness-only text keeps each answer turn separate instead of merging them into "No. Yes."
    expect(part.answerText).not.toBe("No. Yes.");
    expect(part.answerText).toBe("No.\nYes.");
    expect(lines.map((l) => l.rawText)).toEqual(["Q. Did you approve the sale?", "A. No.", "MR. SCOTT: I mean the purchase.", "THE WITNESS: Yes."]);
  });

  it("finding 2: recognizes a multi-word surname as colloquy, not witness testimony", () => {
    const lines = run(20, 1, [
      ["Q. Did you approve?", TURN],
      ["A. No.", TURN],
      ["MR. VAN DYKE: It was approved.", PARA],
    ]);
    const { lines: attributed, parts } = buildExchangeParts(lines, LAYOUT);
    expect(attributed.map((l) => [l.role, l.speakerName])).toEqual([
      ["attorney", null],
      ["witness", null],
      ["colloquy", "MR. VAN DYKE"],
    ]);
    expect(parts[0].answerText).toBe("No.");
    expect(parts[0].dialogueText).toBe("Q: Did you approve?\nA: No.\nMR. VAN DYKE: It was approved.");
  });

  it("finding 2: an explicit but unrecognized speaker label is unknown, never the witness", () => {
    const lines = run(20, 1, [
      ["Q. Did you approve?", TURN],
      ["A. No.", TURN],
      ["COURT REPORTER: Could you repeat", PARA],
      ["the last answer?", null],
    ]);
    const { lines: attributed, parts } = buildExchangeParts(lines, LAYOUT);
    expect(attributed.map((l) => l.role)).toEqual(["attorney", "witness", "unknown", "unknown"]);
    expect(parts[0].lines.map((m) => m.role)).toEqual(["question", "answer", "unknown", "unknown"]);
    expect(parts[0].answerText).toBe("No.");
    expect(parts[0].dialogueText).toBe("Q: Did you approve?\nA: No.\nUNKNOWN SPEAKER: COURT REPORTER: Could you repeat the last answer?");
  });
});

describe("speaker labels alone on their line (Codex follow-up)", () => {
  it("makes a standalone unrecognized label and its continuation unknown, outside the answer", () => {
    const lines = run(20, 1, [
      ["Q. Did you approve?", TURN],
      ["A. No.", TURN],
      ["COURT REPORTER:", PARA],
      ["Please repeat the answer.", null],
    ]);
    const { lines: attributed, parts } = buildExchangeParts(lines, LAYOUT);
    expect(attributed.map((l) => [l.role, l.speakerName])).toEqual([
      ["attorney", null],
      ["witness", null],
      ["unknown", "COURT REPORTER"],
      ["unknown", "COURT REPORTER"],
    ]);
    expect(parts[0].answerText).toBe("No.");
    expect(parts[0].dialogueText).toBe("Q: Did you approve?\nA: No.\nUNKNOWN SPEAKER: COURT REPORTER: Please repeat the answer.");
  });

  it("still attributes a standalone THE WITNESS: label to the witness", () => {
    const lines = run(20, 1, [
      ["Q. Did you approve?", TURN],
      ["MR. RILL: Objection.", PARA],
      ["THE WITNESS:", PARA],
      ["I did not.", null],
    ]);
    const { lines: attributed, parts } = buildExchangeParts(lines, LAYOUT);
    expect(attributed.map((l) => l.role)).toEqual(["attorney", "colloquy", "witness", "witness"]);
    expect(parts[0].answerText).toBe("I did not.");
  });

  it("still reads a standalone MR. X: Q. label as the attorney's question", () => {
    const lines = run(20, 1, [
      ["MR. SCOTT: Q.", PARA],
      ["Has any work been done?", null],
      ["A. No.", TURN],
    ]);
    const { lines: attributed, parts } = buildExchangeParts(lines, LAYOUT);
    expect(attributed.map((l) => [l.role, l.speakerName])).toEqual([
      ["attorney", "MR. SCOTT"],
      ["attorney", "MR. SCOTT"],
      ["witness", null],
    ]);
    expect(parts[0].questionText).toBe("Has any work been done?");
  });
});

describe("long answers", () => {
  // A question, 66 answer lines across 4 pages, and an objection after answer line 50.
  const answerRows: [string, number | null][] = Array.from({ length: 66 }, (_, i) => [
    i === 0 ? "A. answer line 1" : `answer line ${i + 1}`,
    i === 0 ? TURN : null,
  ]);
  answerRows.splice(50, 0, ["MR. RILL: Objection, compound.", PARA], ["THE WITNESS: and so on", PARA]);
  const lines = run(148, 15, [["Q. Why is that?", TURN], ...answerRows]);
  const { exchanges, parts } = buildExchangeParts(lines, LAYOUT);
  const answerIndexes = exchanges[0].lines.filter((m) => m.role === "answer").map((m) => m.index);

  it("counts only witness answer lines toward the 40-line limit", () => {
    expect(answerIndexes).toHaveLength(67); // 66 lines plus the witness resuming after the objection
    expect(parts.map((p) => [p.partNo, p.partCount, p.answerLineCount])).toEqual([
      [1, 2, MAX_ANSWER_LINES],
      [2, 2, 67 - (MAX_ANSWER_LINES - ANSWER_OVERLAP_LINES)],
    ]);
  });

  it("overlaps consecutive parts by exactly 5 answer lines", () => {
    const answersOf = (k: number) => parts[k].lines.filter((m) => m.role === "answer").map((m) => m.index);
    expect(answersOf(0).filter((i) => answersOf(1).includes(i))).toEqual(answerIndexes.slice(35, 40));
  });

  it("loses no answer line, and every part carries the full question", () => {
    const covered = new Set(parts.flatMap((p) => p.lines.filter((m) => m.role === "answer").map((m) => m.index)));
    expect([...covered].sort((a, b) => a - b)).toEqual(answerIndexes);
    for (const p of parts) {
      expect(p.question).toEqual({ first: 0, last: 0 });
      expect(p.questionText).toBe("Why is that?");
      expect(p.groupNo).toBe(1);
    }
  });

  it("keeps the objection, in order, in the part whose answer lines surround it", () => {
    const objection = lines.findIndex((l) => l.rawText.startsWith("MR. RILL"));
    expect(parts[0].lines.some((m) => m.index === objection)).toBe(false);
    expect(parts[1].lines.find((m) => m.index === objection)).toEqual({ index: objection, role: "context" });
    const indexes = parts[1].lines.map((m) => m.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(textOf(lines, [objection + 1])).toEqual(["THE WITNESS: and so on"]);
  });

  it("references source lines without copying them", () => {
    const first = parts[1].answer!;
    expect(lines[first.first].rawText).toBe("answer line 36");
    expect(parts[1].span.last).toBe(lines.length - 1);
  });
});
