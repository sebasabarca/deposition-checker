// A stored deposition exported by `scripts/evidence.ts export-lines`, read back as a DepositionRead, so
// real transcripts that were read once (Hutchinson's scans took OCR) can be stored again in a test
// database through the normal save path, without reading the file. The export is the stored evidence
// as it was: lines with their speaker roles and exchanges with their member lines, never re-derived.
// Exports hold testimony and live under the git-ignored data/raw/.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DepositionRead } from "../ingest";
import type { AttributedLine, ExchangePart } from "../ingest/exchanges";

const Range = z.object({ first: z.number().int().min(0), last: z.number().int().min(0) });
const Export = z.object({
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  witness: z.string(),
  takenOn: z.string().nullable(),
  parserVersion: z.string(),
  validation: z.record(z.string(), z.unknown()),
  lines: z.array(z.object({ pdfPage: z.number().int(), printedPage: z.number().int(), lineNo: z.number().int(), speakerRole: z.string(), speakerName: z.string().nullable(), rawText: z.string(), ocrText: z.string().nullable(), ocrConfidence: z.number().nullable() })),
  parts: z.array(z.object({ groupNo: z.number().int(), partNo: z.number().int(), partCount: z.number().int(), kind: z.string(), flags: z.array(z.string()), span: Range, question: Range.nullable(), answer: Range.nullable(), answerLineCount: z.number().int(), questionText: z.string(), answerText: z.string(), dialogueText: z.string(), lines: z.array(z.object({ index: z.number().int().min(0), role: z.string() })) })),
});

export function readStoredExport(path: string): { fileSha256: string; witness: string; takenOn: string | null; read: DepositionRead } {
  const x = Export.parse(JSON.parse(readFileSync(path, "utf8")));
  const lines = x.lines.map((l, index) => ({ pdfPage: l.pdfPage, printedPage: l.printedPage, lineNo: l.lineNo, lineFromPosition: l.lineNo, indentX: null, rawText: l.rawText, ...(l.ocrText !== null ? { ocrText: l.ocrText } : {}), ...(l.ocrConfidence !== null ? { ocrConfidence: l.ocrConfidence } : {}), index, turn: null, role: l.speakerRole, speakerName: l.speakerName })) as unknown as AttributedLine[];
  const parts = x.parts as unknown as ExchangePart[];
  return { fileSha256: x.fileSha256, witness: x.witness, takenOn: x.takenOn, read: { parserVersion: x.parserVersion, format: "pdf", validation: x.validation as unknown as DepositionRead["validation"], pdf: null, exchanges: { lines, exchanges: [], parts } } };
}
