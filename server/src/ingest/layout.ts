// The one PDF layout ingestion supports: DOJ-typeset deposition transcripts, as measured on
// Ellison P3171 and P3173 (docs/parser-spike.md). Pages that don't match it fail validation;
// there is no attempt to parse other layouts.

export type LayoutProfile = {
  name: string;
  firstLineY: number; // baseline of line 1, in PDF points from the bottom of the page
  lineSpacing: number;
  maxLinesPerPage: number;
  // A page break always continues the testimony when the next page starts at line 1, however many
  // lines the page had. True for numbered text, whose pages come from the file itself; false for
  // PDFs, where a short page can mean lines were redacted.
  pageBreaksContinue?: boolean;
  headerMinY: number; // the printed page number sits at or above this
  footerMaxY: number; // the footer sits at or below this
  rowTolerance: number; // text items within this many points vertically form one row
  wordGap: number; // a horizontal gap wider than this between items becomes a space
  turnIndentMaxX: number; // Q./A. markers start left of this; paragraph and colloquy indents start right of it
  // Every turn names its speaker in full ("ROBERT BAKER:"), as public archives write them, so a full-name
  // label that isn't the witness's is another named speaker, not an unknown one.
  namedSpeakers?: boolean;
  printedPage: RegExp;
  footer: RegExp; // "<name> <MM-DD-YY> <pdf page>", e.g. "Ellison 01-20-04 3"
};

export const ELLISON_DOJ_V1: LayoutProfile = {
  name: "ellison-doj-v1",
  firstLineY: 697.5,
  lineSpacing: 22.5,
  maxLinesPerPage: 22,
  headerMinY: 700,
  footerMaxY: 100,
  rowTolerance: 1.5,
  wordGap: 1,
  turnIndentMaxX: 118,
  printedPage: /^\d{3,6}$/,
  footer: /^\S.* \d{2}-\d{2}-\d{2} (\d+)$/,
};

// Stored on every deposition and used to detect duplicate ingestion. Bump PARSER_REVISION whenever
// extraction, validation, speaker attribution or exchange building changes what a file produces
// (including a pdfjs-dist upgrade), so re-ingesting the same file is a new parse, not a duplicate.
const PARSER_REVISION = 10; // 10: a turn that starts inside an archive statement starts its own exchange (the statement belongs to both, each with its own segments); 9: speaker segments inside archive statements, an archive's full-name labels are named speakers, a whole-line [note] is a note at any indent; 8: a bare statement number in an archive is an empty statement, not text of the one before; 4: ASCII page numbers and timestamps, RTF and DOCX, "Q:" markers; 5: gutterless PDFs by physical line; 6: bracketed rows and page markers are parentheticals; 7: archive utterance numbers (in parts), PDF text layers by printed line numbers, a label naming the witness is the witness
export const PARSER_VERSION = `pdfjs-${ELLISON_DOJ_V1.name}-r${PARSER_REVISION}`;
