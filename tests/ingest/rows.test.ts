import { describe, it, expect } from "vitest";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import type { SourceLine } from "../../server/src/ingest/pdf";
import { lineIdsByPosition, toExchangeLineRows, toExchangeRows, toLineRows } from "../../server/src/ingest/rows";

const TURN = 112.5; // x of a Q./A. marker
const PARA = 124.5; // x of a paragraph or colloquy indent

const src = (printedPage: number, lineNo: number, rawText: string, indentX: number | null = null): SourceLine => ({
  pdfPage: printedPage - 160,
  printedPage,
  lineNo,
  lineFromPosition: lineNo,
  indentX,
  rawText,
});

// Two exchanges across a page break, the second interrupted by an objection.
const { lines, parts } = buildExchangeParts(
  [
    src(161, 21, "Q. Did you approve the SAP deal?", TURN),
    src(161, 22, "A. No, I didn't.", TURN),
    src(162, 1, "Q. Who did?", TURN),
    src(162, 2, "MR. RILL: Objection, foundation.", PARA),
    src(162, 3, "A. Safra Catz, I believe.", TURN),
  ],
  LAYOUT,
);

// Line IDs as the database might assign them: not 1, 2, 3, and returned in any order.
const stored = lines.map((l, i) => ({ id: 1000 + 10 * i, printedPage: l.printedPage!, lineNo: l.lineNo }));
const ids = lineIdsByPosition(lines, [...stored].reverse());

describe("toLineRows", () => {
  it("stores every line with its page:line, speaker, raw text and normalized text", () => {
    const rows = toLineRows(7, lines);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({
      depositionId: 7,
      pdfPage: 1,
      printedPage: 161,
      lineNo: 22,
      speakerRole: "witness",
      speakerName: null,
      rawText: "A. No, I didn't.",
      normText: "a no i didn t",
    });
    expect(rows[3]).toMatchObject({ printedPage: 162, lineNo: 2, speakerRole: "colloquy", speakerName: "MR. RILL" });
  });

  it("refuses a line without a printed page instead of storing it under a made-up one", () => {
    expect(() => toLineRows(7, [{ ...lines[0], printedPage: null }])).toThrow(/no printed page/);
  });
});

describe("lineIdsByPosition", () => {
  it("matches stored lines by page:line, whatever order they come back in", () => {
    expect(ids).toEqual([1000, 1010, 1020, 1030, 1040]);
  });

  it("fails when a line is missing from the stored rows", () => {
    expect(() => lineIdsByPosition(lines, stored.slice(1))).toThrow("line 161:21 was not stored");
  });
});

describe("toExchangeRows", () => {
  it("translates each part's line positions into stored line IDs", () => {
    const rows = toExchangeRows(7, 3, parts, ids);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      depositionId: 7,
      witnessId: 3,
      groupId: parts[1].groupNo,
      partNo: 1,
      partCount: 1,
      kind: "qa",
      firstLineId: 1020,
      lastLineId: 1040,
      questionFirstLineId: 1020,
      questionLastLineId: 1020,
      answerFirstLineId: 1040,
      answerLastLineId: 1040,
      answerLineCount: 1,
      answerText: "Safra Catz, I believe.",
    });
  });

  it("keeps a missing question or answer as null rather than inventing an endpoint", () => {
    const [row] = toExchangeRows(7, 3, [{ ...parts[0], question: null }], ids);
    expect([row.questionFirstLineId, row.questionLastLineId]).toEqual([null, null]);
  });

  it("fails on a line position that doesn't exist", () => {
    expect(() => toExchangeRows(7, 3, [{ ...parts[0], span: { first: 0, last: 9 } }], ids)).toThrow(/position 9/);
  });
});

describe("toExchangeLineRows", () => {
  it("lists every member line of each part with its role, matched to stored parts by group and part number", () => {
    const storedParts = parts.map((p, i) => ({ id: 50 + i, groupId: p.groupNo, partNo: p.partNo })).reverse();
    expect(toExchangeLineRows(7, parts, storedParts, ids)).toEqual([
      { exchangeId: 50, lineId: 1000, depositionId: 7, role: "question" },
      { exchangeId: 50, lineId: 1010, depositionId: 7, role: "answer" },
      { exchangeId: 51, lineId: 1020, depositionId: 7, role: "question" },
      { exchangeId: 51, lineId: 1030, depositionId: 7, role: "context" },
      { exchangeId: 51, lineId: 1040, depositionId: 7, role: "answer" },
    ]);
  });

  it("fails when a part was not stored", () => {
    expect(() => toExchangeLineRows(7, parts, [], ids)).toThrow(/was not stored/);
  });
});
