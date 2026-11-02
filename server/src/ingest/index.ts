// Public entry point of the ingest module.
// PDF bytes -> validated page:line source lines -> speakers, exchanges and long-answer parts,
// then stored in Postgres with the uploaded file kept under data/uploads/.

import { ELLISON_DOJ_V1, PARSER_VERSION, type LayoutProfile } from "./layout";
import { buildExchangeParts, surnameOf, type ExchangeResult } from "./exchanges";
import { extractPdf, type ExtractedPdf } from "./pdf";
import { inferPageNumbers, ocrDocument, SCANNED_25_V1, type OcrReader } from "./ocr";
import { validateDeposition, type Validation } from "./validate";
import type { Database } from "../db/client";
import { saveDeposition, type SaveResult } from "./store";
import { isPdf, storeUpload, UPLOADS_DIR } from "./uploads";
import { isText, readText } from "./text";
import { timed, timedSync } from "../timing";

export { ELLISON_DOJ_V1, PARSER_VERSION };
export type { LayoutProfile } from "./layout";
export type { PageExtraction, SourceLine } from "./pdf";
export type { AttributedLine, Exchange, ExchangeLine, ExchangePart, LineRange, LineRole, SpeakerRole } from "./exchanges";
export type { DepositionStatus, PageStatus, PageValidation, Validation } from "./validate";
export {
  depositionLockKey,
  saveDeposition,
  type CurrentRun,
  type NotCurrent,
  type SaveInput,
  type SaveOutcome,
  type SaveResult,
} from "./store";
export { inferPageNumbers, LOW_WORD_CONFIDENCE, MAX_OCR_PAGES, ocrDocument, parseTsv, readOcrPage, SCANNED_25_V1, type OcrPage, type OcrReader, type OcrResult, type OcrWord } from "./ocr";
export { isPdf, readUpload, storeUpload, UPLOADS_DIR } from "./uploads";
export { isText, readTextPages, TEXT_NUMBERED_V1, TEXT_UNNUMBERED_V1, UNNUMBERED_PAGE } from "./text";

export type DepositionRead = {
  parserVersion: string;
  format?: "pdf" | "text"; // absent means pdf
  validation: Validation;
  pdf: ExtractedPdf | null; // null when the file could not be opened as a PDF
  // Built only for a ready deposition, so pages that failed validation never produce evidence.
  exchanges: ExchangeResult | null;
};

// A file with no text layer at all goes through OCR. A file mixing text and scanned pages stays as it
// was, with those pages needs_ocr. shortcut: mixed files aren't OCR'd; add it when one appears.
async function readScanned(pdf: ExtractedPdf, data: Uint8Array, ocr: OcrReader, witnessSurname?: string): Promise<DepositionRead | { unavailable: string }> {
  const result = await timed("ingest.ocr", () => ocr(data, pdf.pageCount));
  if (!result.available) return { unavailable: result.reason };
  const pages = result.pages;
  const inferredPages = inferPageNumbers(pages);
  const validation = validateDeposition(pages, SCANNED_25_V1);
  const confidences = pages.flatMap((p) => p.lines.map((l) => l.ocrConfidence!));
  validation.ocr = {
    engine: result.engine,
    meanConfidence: confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null,
    lowConfidenceWords: pages.reduce((n, p) => n + p.ocr.lowConfidenceWords, 0),
    annotations: pages.flatMap((p) => p.ocr.annotations.map((text) => ({ pdfPage: p.pdfPage, text }))),
    noiseWords: pages.reduce((n, p) => n + p.ocr.noiseWords, 0),
    coverPages: pages.filter((p) => p.ocr.coverPage).map((p) => p.pdfPage),
    inferredPages,
    markersCorrected: pages.reduce((n, p) => n + p.ocr.markersCorrected, 0),
    pipesCorrected: pages.reduce((n, p) => n + p.ocr.pipesCorrected, 0),
  };
  const exchanges = validation.status === "ready" ? buildExchangeParts(pages.flatMap((p) => p.lines), SCANNED_25_V1, witnessSurname) : null;
  return { parserVersion: PARSER_VERSION, pdf: { pageCount: pdf.pageCount, pages }, validation, exchanges };
}

export async function readDeposition(data: Uint8Array, layout: LayoutProfile = ELLISON_DOJ_V1, ocr: OcrReader = ocrDocument, witnessName?: string): Promise<DepositionRead> {
  const witnessSurname = witnessName ? surnameOf(witnessName) : undefined;
  if (!isPdf(data) && isText(data)) return { parserVersion: PARSER_VERSION, format: "text", ...timedSync("ingest.text_parse", () => readText(data, witnessSurname)) };
  let pdf: ExtractedPdf;
  try {
    pdf = await timed("ingest.pdf_parse", () => extractPdf(data, layout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      parserVersion: PARSER_VERSION,
      pdf: null,
      exchanges: null,
      validation: {
        status: "unsupported",
        layout: layout.name,
        pageCount: 0,
        counts: { text: 0, blank: 0, needs_ocr: 0, failed: 0 },
        needsOcrPages: [],
        blankPages: [],
        failedPages: [],
        reasons: [`the file could not be read as a PDF: ${message}`],
        pages: [],
      },
    };
  }
  if (pdf.pages.length > 0 && pdf.pages.every((p) => !p.hasText)) {
    const scanned = await readScanned(pdf, data, ocr, witnessSurname);
    if (!("unavailable" in scanned)) return scanned;
    const validation = timedSync("ingest.validate", () => validateDeposition(pdf.pages, layout));
    validation.reasons.push(scanned.unavailable);
    return { parserVersion: PARSER_VERSION, pdf, validation, exchanges: null };
  }
  const validation = timedSync("ingest.validate", () => validateDeposition(pdf.pages, layout));
  // A text layer no page of which fits is often a scanner's own OCR: read the scan itself instead, and
  // keep the result only if it does better. A file that fits in part stays as it was.
  if (validation.counts.text === 0 && validation.counts.failed > 0) {
    const scanned = await readScanned(pdf, data, ocr, witnessSurname);
    if (!("unavailable" in scanned) && scanned.validation.counts.text > 0) return scanned;
  }
  const exchanges = validation.status === "ready" ? timedSync("ingest.build_exchanges", () => buildExchangeParts(pdf.pages.flatMap((p) => p.lines), layout, witnessSurname)) : null;
  return { parserVersion: PARSER_VERSION, pdf, validation, exchanges };
}

export type IngestTarget = { caseId: number; witnessId: number; takenOn: string | null; witnessName?: string };

// Stores the file, reads it and saves the result. Every file is saved, whatever its status, so a
// PDF that can't be used still appears with the reasons; only a ready one gets lines and exchanges.
// A file already stored as ready keeps its evidence if this attempt fails (see store.ts).
export async function ingestFile(db: Database, data: Uint8Array, { witnessName, ...target }: IngestTarget, uploadsDir = UPLOADS_DIR): Promise<SaveResult> {
  const { fileSha256, storageKey } = await storeUpload(data, uploadsDir);
  const read = await readDeposition(data, undefined, undefined, witnessName);
  return saveDeposition(db, { ...target, fileSha256, storageKey, read });
}
