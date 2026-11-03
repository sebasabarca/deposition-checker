// How a stored line is cited, by the scheme its transcript actually uses. Pure. A line is stored as
// (printed_page, line_no) whatever the format; what those numbers mean depends on how the file was read,
// so they are never shown as a court reporter's page:line unless that is what they are.

export const REFERENCE_SCHEMES = [
  "page_line", // the transcript's printed page and line numbers (certified depositions; text with numbered lines)
  "file_line", // a line of a text file with no page or line numbers (stored on page 0)
  "physical_line", // a PDF row counted by Veridict on a page with no printed line numbers
  "archive_statement", // an archive's sequential statement numbers (page holds the run, when the count restarts)
  "unrecognized", // a layout this module doesn't know: kept as stored, never presented as citable
] as const;
export type ReferenceScheme = (typeof REFERENCE_SCHEMES)[number];

const SCHEME_BY_LAYOUT: Record<string, ReferenceScheme> = {
  "ellison-doj-v1": "page_line",
  "scanned-25-v1": "page_line",
  "text-numbered-v1": "page_line",
  "text-unnumbered-v1": "file_line",
  "pdf-physical-v1": "physical_line",
  "text-archive-lines-v1": "archive_statement",
};

export const schemeOf = (layout: string | null | undefined): ReferenceScheme => (layout ? (SCHEME_BY_LAYOUT[layout] ?? "unrecognized") : "unrecognized");

// Only a printed page:line is a citation a court reporter would recognize.
export const isCitable = (scheme: ReferenceScheme) => scheme === "page_line";

export function formatRef(scheme: ReferenceScheme, page: number, line: number): string {
  switch (scheme) {
    case "page_line":
      return `${page}:${String(line).padStart(2, "0")}`;
    case "file_line":
      return `line ${line}`;
    case "physical_line":
      return `page ${page}, row ${line}`;
    case "archive_statement":
      return page <= 1 ? `statement ${line}` : `statement ${line} (part ${page})`;
    case "unrecognized":
      return `${page}/${line} (unrecognized layout)`;
  }
}

// A source line's stable identity: the file it comes from and its stored position, independent of the
// database row (which re-ingestion replaces) and of the scheme it is shown in.
export const sourceLineId = (fileSha256: string, page: number, line: number) => `src_${fileSha256.slice(0, 16)}_${page}_${line}`;
