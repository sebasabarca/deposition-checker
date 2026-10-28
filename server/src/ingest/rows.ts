// Turns a read deposition into database rows. Pure: no I/O.
// In memory, exchange parts refer to lines by their position in the deposition's line list. The
// database gives lines their own IDs, so parts are written in two steps: lines first, then parts
// with each position translated to the stored line's ID through its page:line.

import type { exchangeLines, exchanges, lines } from "../db/schema";
import { normalize } from "../verify";
import type { AttributedLine, ExchangePart, LineRange } from "./exchanges";

export type LineRow = Omit<typeof lines.$inferInsert, "id">;
export type ExchangeRow = Omit<typeof exchanges.$inferInsert, "id">;
export type ExchangeLineRow = typeof exchangeLines.$inferInsert;
export type StoredLine = { id: number; printedPage: number; lineNo: number };

const pageLine = (printedPage: number, lineNo: number) => `${printedPage}:${lineNo}`;
const partKey = (groupId: number, partNo: number) => `${groupId}/${partNo}`;

export function toLineRows(depositionId: number, attributed: AttributedLine[]): LineRow[] {
  return attributed.map((line) => {
    // Validation fails any text page without a printed page, so a ready deposition never has one.
    if (line.printedPage === null) {
      throw new Error(`line ${line.lineNo} on PDF page ${line.pdfPage} has no printed page; only ready depositions are stored`);
    }
    return {
      depositionId,
      pdfPage: line.pdfPage,
      printedPage: line.printedPage,
      lineNo: line.lineNo,
      speakerRole: line.role,
      speakerName: line.speakerName,
      rawText: line.rawText,
      normText: normalize(line.rawText),
    };
  });
}

// The stored ID of each line, by position. Matched on page:line rather than on insert order, which
// Postgres doesn't promise to preserve in what it returns.
export function lineIdsByPosition(attributed: AttributedLine[], stored: StoredLine[]): number[] {
  const ids = new Map(stored.map((s) => [pageLine(s.printedPage, s.lineNo), s.id]));
  return attributed.map((line) => {
    const id = line.printedPage === null ? undefined : ids.get(pageLine(line.printedPage, line.lineNo));
    if (id === undefined) throw new Error(`line ${line.printedPage}:${line.lineNo} was not stored`);
    return id;
  });
}

export function toExchangeRows(
  depositionId: number,
  witnessId: number,
  parts: ExchangePart[],
  lineIds: number[],
): ExchangeRow[] {
  const idOf = (index: number) => {
    const id = lineIds[index];
    if (id === undefined) throw new Error(`exchange part refers to line position ${index}, which doesn't exist`);
    return id;
  };
  const ends = (r: LineRange | null) => (r === null ? [null, null] : [idOf(r.first), idOf(r.last)]);
  return parts.map((part) => {
    const [questionFirstLineId, questionLastLineId] = ends(part.question);
    const [answerFirstLineId, answerLastLineId] = ends(part.answer);
    return {
      depositionId,
      witnessId,
      groupId: part.groupNo,
      partNo: part.partNo,
      partCount: part.partCount,
      kind: part.kind,
      flags: part.flags,
      firstLineId: idOf(part.span.first),
      lastLineId: idOf(part.span.last),
      questionFirstLineId,
      questionLastLineId,
      answerFirstLineId,
      answerLastLineId,
      answerLineCount: part.answerLineCount,
      questionText: part.questionText,
      answerText: part.answerText,
      dialogueText: part.dialogueText,
    };
  });
}

// Every line of every part, with its role. Stored parts are matched to in-memory parts by
// group and part number, again not by insert order.
export function toExchangeLineRows(
  depositionId: number,
  parts: ExchangePart[],
  storedParts: { id: number; groupId: number; partNo: number }[],
  lineIds: number[],
): ExchangeLineRow[] {
  const ids = new Map(storedParts.map((p) => [partKey(p.groupId, p.partNo), p.id]));
  return parts.flatMap((part) => {
    const exchangeId = ids.get(partKey(part.groupNo, part.partNo));
    if (exchangeId === undefined) throw new Error(`exchange part ${partKey(part.groupNo, part.partNo)} was not stored`);
    return part.lines.map((member) => {
      const lineId = lineIds[member.index];
      if (lineId === undefined) throw new Error(`exchange part refers to line position ${member.index}, which doesn't exist`);
      return { exchangeId, lineId, depositionId, role: member.role };
    });
  });
}
