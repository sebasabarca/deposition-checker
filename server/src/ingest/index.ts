// Public entry point of the ingest module.
// PDF bytes -> validated page:line source lines -> speakers, exchanges and long-answer parts,
// then stored in Postgres with the uploaded file kept under data/uploads/.

import { ELLISON_DOJ_V1, PARSER_VERSION, type LayoutProfile } from "./layout";
import { buildExchangeParts, type ExchangeResult } from "./exchanges";
import { extractPdf, type ExtractedPdf } from "./pdf";
import { validateDeposition, type Validation } from "./validate";
import type { Database } from "../db/client";
import { saveDeposition, type SaveResult } from "./store";
import { storeUpload, UPLOADS_DIR } from "./uploads";

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
export { isPdf, readUpload, storeUpload, UPLOADS_DIR } from "./uploads";

export type DepositionRead = {
  parserVersion: string;
  validation: Validation;
  pdf: ExtractedPdf | null; // null when the file could not be opened as a PDF
  // Built only for a ready deposition, so pages that failed validation never produce evidence.
  exchanges: ExchangeResult | null;
};

export async function readDeposition(data: Uint8Array, layout: LayoutProfile = ELLISON_DOJ_V1): Promise<DepositionRead> {
  let pdf: ExtractedPdf;
  try {
    pdf = await extractPdf(data, layout);
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
  const validation = validateDeposition(pdf.pages, layout);
  const exchanges = validation.status === "ready" ? buildExchangeParts(pdf.pages.flatMap((p) => p.lines), layout) : null;
  return { parserVersion: PARSER_VERSION, pdf, validation, exchanges };
}

export type IngestTarget = { caseId: number; witnessId: number; takenOn: string | null };

// Stores the file, reads it and saves the result. Every file is saved, whatever its status, so a
// PDF that can't be used still appears with the reasons; only a ready one gets lines and exchanges.
// A file already stored as ready keeps its evidence if this attempt fails (see store.ts).
export async function ingestFile(db: Database, data: Uint8Array, target: IngestTarget, uploadsDir = UPLOADS_DIR): Promise<SaveResult> {
  const { fileSha256, storageKey } = await storeUpload(data, uploadsDir);
  const read = await readDeposition(data);
  return saveDeposition(db, { ...target, fileSha256, storageKey, read });
}
