// Several logical turns inside one archive statement (parser revision 10), on a SYNTHETIC archive
// export (invented speakers and testimony). A statement stays one source line with its text and
// reference untouched; a new question inside it starts a new exchange, and the statement belongs to
// both exchanges, each with only its own segments.
import { describe, expect, it } from "vitest";
import { readDeposition } from "../../server/src/ingest";
import type { ExchangePart } from "../../server/src/ingest/exchanges";
import { evidenceFieldsOf } from "../../server/src/evidence";
import { inWindow } from "../../server/src/ingest/rows";

const filler = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i} ${i % 2 ? "A" : "Q"}: synthetic statement ${from + i} about the harbour crane.`);
const archive = (statements: string[]) => new TextEncoder().encode(["ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC)", ...statements].join("\n"));

async function read(statements: string[]) {
  const r = await readDeposition(archive(statements), undefined, undefined, "Iris Calloway");
  if (!r.exchanges) throw new Error(`not ready: ${JSON.stringify(r.validation.reasons ?? r.validation.status)}`);
  return r.exchanges;
}
// The parts holding a statement, in order, and the text of each part's segments of it.
const holding = (parts: ExchangePart[], lines: { index: number; lineNo: number }[], lineNo: number) => parts.filter((p) => p.lines.some((m) => lines[m.index].lineNo === lineNo));

const STATEMENTS = [
  "1 Q: Where were you on the night of the storm?",
  "2 A: At the harbour office. Q. Who else was there?",
  "3 A: Only the night clerk.",
  "4 Q: Did the crane move? A.Yes, it did.",
  "5 Q: When did you leave?",
  "6 A: Late. Q: How late? A: After midnight. Q. Why so late?",
  "7 A: The ledger was not finished.",
  "8 Q: What did the clerk write?",
  `9 A: He wrote "Q. Are you sure? A. Yes." in the log.`,
  ...filler(10, 40),
];

describe("several turns inside one archive statement", () => {
  it("ends an exchange at an answer and starts the next at the question that follows it on the same statement", async () => {
    const { lines, parts } = await read(STATEMENTS);
    const [first, second] = holding(parts, lines, 2);
    expect(first.questionText).toContain("Where were you on the night of the storm?");
    expect(first.answerText).toBe("A: At the harbour office.");
    expect(first.questionText).not.toContain("Who else");
    expect(second.questionText).toBe("Who else was there?"); // "Q." is stripped, as on any line
    expect(second.answerText).toContain("Only the night clerk.");
    expect(second.answerText).not.toContain("harbour office");
    expect([first.flags, second.flags]).toEqual([[], []]);
    // The statement itself: one source line, its text as printed, in both exchanges.
    const line = lines.find((l) => l.lineNo === 2)!;
    expect(line.rawText).toBe("A: At the harbour office. Q. Who else was there?");
    expect(first.lines.at(-1)).toMatchObject({ index: line.index, role: "answer", segments: { from: 0, to: 0 } });
    expect(second.lines[0]).toMatchObject({ index: line.index, role: "question", segments: { from: 1, to: 1 } });
  });

  it("keeps a question and its answer on one statement as one complete exchange", async () => {
    const { lines, parts } = await read(STATEMENTS);
    const [x] = holding(parts, lines, 4);
    expect(holding(parts, lines, 4)).toHaveLength(1);
    expect(x.questionText).toContain("Did the crane move?");
    expect(x.answerText).toBe("Yes, it did.");
    expect(x.flags).toEqual([]);
    expect(x.answer).not.toBeNull();
    expect(x.question).not.toBeNull();
  });

  it("gives each question inside a statement holding several turns its own exchange", async () => {
    const { lines, parts } = await read(STATEMENTS);
    const three = holding(parts, lines, 6);
    expect(three.map((p) => [p.questionText, p.answerText])).toEqual([
      [expect.stringContaining("When did you leave?"), "A: Late."],
      ["Q: How late?", "A: After midnight."],
      ["Why so late?", expect.stringContaining("The ledger was not finished.")],
    ]);
    expect(three.map((p) => p.flags)).toEqual([[], [], []]);
    expect(new Set(three.map((p) => p.groupNo)).size).toBe(3);
  });

  it("never makes a turn of Q/A labels inside quoted text", async () => {
    const { lines, parts } = await read(STATEMENTS);
    expect(lines.find((l) => l.lineNo === 9)!.segments).toBeUndefined();
    const [x] = holding(parts, lines, 9);
    expect(holding(parts, lines, 9)).toHaveLength(1);
    expect(x.answerText).toBe(`A: He wrote "Q. Are you sure? A. Yes." in the log.`);
  });

  it("gives each exchange its own evidence key and a verified speaker status from its own segments", async () => {
    const { lines, parts } = await read(STATEMENTS);
    const fields = (p: ExchangePart) => evidenceFieldsOf("f".repeat(64), p.kind, p.lines.map((m) => {
      const l = lines[m.index];
      return { page: l.printedPage ?? 0, line: l.lineNo, text: l.rawText, lineRole: m.role, speakerRole: l.role, segments: inWindow(l.segments ?? [], m.segments).map((s) => ({ role: s.role, start: s.start, end: s.end })) };
    }));
    const six = holding(parts, lines, 6).map(fields);
    expect(new Set(six.map((f) => f.evidenceKey)).size).toBe(3);
    expect(six.map((f) => f.speakerStatus)).toEqual(["verified", "verified", "verified"]);
    // The exchange that only asks "Why so late?" on statement 6 gets its answer from statement 7, not 6.
    expect(holding(parts, lines, 2).map(fields).map((f) => f.speakerStatus)).toEqual(["verified", "verified"]);
  });

  it("keeps a long answer's parts continuous when its last statement also asks the next question", async () => {
    const answers = Array.from({ length: 45 }, (_, i) => `${i + 2} A: synthetic answer sentence ${i + 1} about the ledger.`);
    answers[44] = "46 A: synthetic answer sentence 45 about the ledger. Q. And after that?";
    const { lines, parts } = await read(["1 Q: Tell me about the ledger.", ...answers, "47 A: I went home.", ...filler(48, 60)]);
    const long = parts.filter((p) => p.groupNo === parts.find((x) => x.lines.some((m) => lines[m.index].lineNo === 1))!.groupNo);
    expect(long.map((p) => p.answerLineCount)).toEqual([40, 10]);
    const answerLines = (p: ExchangePart) => p.lines.filter((m) => m.role === "answer").map((m) => lines[m.index].lineNo);
    // Consecutive parts share 5 answer lines, and together they hold every answer statement once more.
    expect(answerLines(long[0]).slice(-5)).toEqual(answerLines(long[1]).slice(0, 5));
    expect(new Set(long.flatMap(answerLines))).toEqual(new Set(Array.from({ length: 45 }, (_, i) => i + 2)));
    expect(long.every((p) => p.questionText.includes("Tell me about the ledger."))).toBe(true);
    expect(long[1].answerText).not.toContain("And after that?");
    const [, next] = holding(parts, lines, 46).filter((p, i, all) => all.findIndex((q) => q.groupNo === p.groupNo) === i);
    expect(next.questionText).toBe("And after that?");
    expect(next.answerText).toBe("A: I went home.");
  });
});
