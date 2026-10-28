// Public entry point of the ingest module.
// PDF bytes -> validated page:line source lines -> speakers, exchanges and long-answer parts.

import { ELLISON_DOJ_V1, PARSER_VERSION, type LayoutProfile } from "./layout";
import { buildExchangeParts, type ExchangeResult } from "./exchanges";
import { extractPdf, type ExtractedPdf } from "./pdf";
import { validateDeposition, type Validation } from "./validate";

export { ELLISON_DOJ_V1, PARSER_VERSION };
export type { LayoutProfile } from "./layout";
export type { PageExtraction, SourceLine } from "./pdf";
export type { AttributedLine, Exchange, ExchangeLine, ExchangePart, LineRange, LineRole, SpeakerRole } from "./exchanges";
export type { DepositionStatus, PageStatus, PageValidation, Validation } from "./validate";

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
