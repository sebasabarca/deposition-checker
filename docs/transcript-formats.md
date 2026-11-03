# Transcript formats

How Veridict reads deposition transcripts other than PDF, what it supports, what it has been tested
against, and what is still missing. Measured on 2 November 2026.

## How a file is read

Every format ends in the same place as a PDF: page:line source lines (`SourceLine`), then speakers,
exchanges and long-answer parts (`buildExchangeParts`), then storage. Extraction is separate from
structure:

| Step | Code |
|---|---|
| Which format a file is, from its bytes; proprietary formats refused with what to ask for | `server/src/ingest/formats.ts` |
| Text decoding: UTF-8, UTF-16 with a byte-order mark, else Windows-1252 (noted as a warning) | `decodeText` in `server/src/ingest/text.ts` |
| RTF text extraction (paragraphs, line and page breaks, escapes, code pages; headers, footers, fonts, fields, pictures and hidden groups left out) | `server/src/ingest/rtf.ts` |
| DOCX text extraction (paragraphs, two-column line-number tables, page breaks, page-break-before, next-page sections; headers, footers, comments, deletions, field codes and text boxes left out) | `server/src/ingest/docx.ts`, `server/src/ingest/zip.ts` |
| Line numbers kept as a formatting setting (Word line numbering, RTF `\linemod`) | `server/src/ingest/numbering.ts` |
| Page:line structure of the text, for every text format | `readTextPages` in `server/src/ingest/text.ts` |

Nothing is invented. A page number that isn't printed is inferred from the page before and flagged
(the citation shows "page number inferred; verify"); timestamps beside line numbers are removed and
counted; rows without a line number (running heads, footers, signature names) are kept out of the
testimony and counted; skipped line numbers and pages out of order are warnings. Warnings are stored on
the deposition (`validation.warnings`) and shown on its page under "Check before citing". Text with no
page and line numbers at all is still accepted, cited as "Line N" and never by page:line. No model is
used anywhere in reading a transcript.

## Compatibility

| Format | Status | Tested against |
|---|---|---|
| PDF (text layer or scanned) | Supported (unchanged) | Existing PDF tests |
| PDF with printed line numbers in another layout (born digital) | Supported from its own text layer (`ingest/pdfText.ts`), before OCR: lines by their printed numbers, clock times removed, page number from the right of the page or inferred and flagged, cover and exhibit pages named and kept out, rows that exactly fill a gap in the numbers numbered by position and flagged. A scan's hidden text layer is used only when OCR can't read it, with a warning, because it can drop words beside redactions | `tests/ingest/pdfText.test.ts`; readback `sample-full.pdf` matches its .txt on all 271 lines, Legal Informatics `li-sample.pdf` matches Poppler on all 88 |
| PDF with a text layer but no line-number gutter | Supported by **physical line** (parser revision 5): each page's rows numbered in order on that PDF page, repeated headers and footers kept out, every reference labelled "physical line, not an official line number" and held at needs context. Used only when no page fits the gutter layout and OCR finds none; rows that mostly start with a line number are never renumbered | `tests/ingest/physical.test.ts`; the synthetic suite's `pdf_deposition_01/02.pdf` read as ready |
| ASCII / page-image text: `.txt`, `.asc`, pasted text | **Supported** | 2 genuine independent samples, plus synthetic edge cases |
| RTF: `.rtf` | **Partially supported**: implemented and tested, but no genuine court-reporter RTF yet | 2 derived files (genuine ASCII converted by macOS `textutil`), synthetic edge cases |
| Word: `.docx` | **Partially supported**: implemented and tested, but no genuine court-reporter DOCX yet | 2 derived files (as above), synthetic edge cases |
| E-Transcript: `.ptx`, `.ptz` | **Unsupported**: refused with an explanation and the advice to export ASCII from the free E-Transcript viewer or ask the reporter for ASCII or PDF | No samples available |
| LiveNote `.lef`, `.ptf` | **Unsupported**: refused with an explanation | No samples available |
| Word 97–2003 `.doc`, WordPerfect `.wpd` | Unsupported: refused, with "save as .docx" | – |

"Partially supported" means the adapter works on every file it has been given, including files written
by real software, but it has not yet met the bar of two independent genuine court-reporter exports.
Treat RTF and DOCX results with the same care as any first use, and check the warnings.

## Samples

Originals are in `data/raw/transcripts/` and are not in git (no licence is stated for them). The
manifest with sources and SHA-256 hashes is `tests/fixtures/transcripts/samples.json`; ground truth is
beside it, verified by hand against each original file and its independent PDF rendering.

| Sample | Format | Kind | Source | Conventions |
|---|---|---|---|---|
| readback-ascii | text | genuine | [Readback samples](https://readbackhq.com/samples/) `sample-deposition.txt` (with `sample-full.pdf`) | US (California) deposition, synthetic names; 25 lines; page number right-aligned above each page; form feeds; CRLF; double-spaced rows; clock timestamps after each testimony line; index, exhibit list, certificate, declaration, errata pages |
| legalinformatics-ascii | text | genuine | [Legal Informatics, Discover E-Transcripts](https://www.legalinformatics.ca/discover-e-transcripts) TXT (with its PDF) | Canadian Federal Court cross-examination excerpt; 28 lines; zero-padded page numbers (`001`); `Q`/`A` without periods; reporter footer on every page; UTF-8 curly quotes and ellipses; LF |
| readback-ascii-as-rtf, legalinformatics-ascii-as-rtf | rtf | derived | the genuine ASCII above, through `textutil -convert rtf` | Cocoa RTF: `\` line breaks, `\ansicpg1252`, font and colour tables |
| readback-ascii-as-docx, legalinformatics-ascii-as-docx | docx | derived | the genuine ASCII above, through `textutil -convert docx` | One paragraph per row, deflated ZIP |

Two exports of one deposition count as one sample, and derived files never count; that is why RTF and
DOCX are still short of samples.

## Validation

`npx tsx scripts/transcript-validation.ts` measures every sample against its ground truth; the format
tests (`tests/ingest/transcripts.test.ts`) require exact agreement.

| Sample | Kind | Format | Parsed | Pages | Lines at page:line | Exact text | Speakers | Q/A exchanges | Warnings | Parse failures | Same on rerun |
|---|---|---|---|---|---|---|---|---|---|---|---|
| readback-ascii | genuine | text | 16 pages, 400 lines | 16/16 | 28/28 | 28/28 | 20/20 | 4/4 | 2 (2/2 expected) | 0 | yes |
| legalinformatics-ascii | genuine | text | 5 pages, 116 lines | 5/5 | 20/20 | 20/20 | 18/18 | 3/3 | 1 (1/1 expected) | 0 | yes |
| readback-ascii-as-rtf | derived | rtf | 16 pages, 400 lines | 16/16 | 28/28 | 28/28 | 20/20 | 4/4 | 2 (2/2 expected) | 0 | yes |
| readback-ascii-as-docx | derived | docx | 16 pages, 400 lines | 16/16 | 28/28 | 28/28 | 20/20 | 4/4 | 2 (2/2 expected) | 0 | yes |
| legalinformatics-ascii-as-rtf | derived | rtf | 5 pages, 116 lines | 5/5 | 20/20 | 20/20 | 18/18 | 3/3 | 1 (1/1 expected) | 0 | yes |
| legalinformatics-ascii-as-docx | derived | docx | 5 pages, 116 lines | 5/5 | 20/20 | 20/20 | 18/18 | 3/3 | 1 (1/1 expected) | 0 | yes |

The ground truth covers representative lines (cover, index, examination start, objections, exhibit
parentheticals, answers and questions crossing pages, certificate, errata) and every page's number and
line count, not every line. Before this work the text reader took the Readback file's right-aligned
page numbers for line numbers: it produced 32 pages (16 of them one line long) and lost the timestamps
into the testimony; that is fixed in the shared reader, not for this file.

Synthetic edge cases (`tests/ingest/formats.test.ts`): page numbers missing or out of order, line
numbers restarting and skipping, timestamps before, after and at the end of line numbers, wrapped
testimony, answers crossing pages, objections inside answers, headers, footers, index and certificate
rows, `Q.` / `Q:` / `Q` + tab markers, Unicode punctuation, Windows-1252 and UTF-16 files, truncated
RTF and DOCX, binary data, rereading the same file; RTF control words, escapes, `\u` characters, code
pages, paragraph and page breaks, hidden destinations, formatting line numbers; DOCX paragraphs,
tables, page breaks, page-break-before, section breaks, headers, deletions, field codes and Word line
numbering. The upload route is tested end to end with RTF and DOCX (`tests/db/workflow-api.test.ts`):
uploaded, read by the background worker, stored, reuploaded as the same deposition, and `.ptx`
refused with a 415.

## E-Transcript (.ptx) investigation

The format belongs to Thomson Reuters (RealLegal E-Transcript). It is read by the free
[E-Transcript Bundle Viewer](https://legal.thomsonreuters.com/en/support/software-downloads/reallegal/e-transcript-bundle-viewer),
which can export ASCII. The UK National Archives' PRONOM registry lists it as structured text
([fmt/728](https://www.nationalarchives.gov.uk/pronom/fmt/728)), but there is no published
specification, the files can carry the full and condensed transcript, word index, annotations and
links, and the software offers password protection. No genuine `.ptx` sample was found publicly.
Without samples and a documented, permitted way to read the files, Veridict does not attempt them:
uploads are refused with the advice to export ASCII from the viewer or ask the reporter for ASCII or
PDF. `.lef` and `.ptf` were not investigated beyond their names, for the same lack of samples.

## Limitations and gaps

- **Samples still needed:** two genuine, independent court-reporter RTF exports and two DOCX exports
  (ideally from different CAT software, such as Case CATalyst, Eclipse and ProCAT); any genuine
  `.ptx`, `.lef` or `.ptf`. A third ASCII sample from US CAT software would also help: both current
  ASCII samples are small (16 and 5 pages).
- **Ground truth is representative**, not exhaustive: every page's number and line count, and 20–28
  hand-checked lines per sample.
- **Line numbering kept as formatting** is recovered only when the layout is unambiguous (numbering
  restarts each page, explicit page breaks, no line long enough to wrap, at most 30 lines a page);
  otherwise the file is read without page:line and says why. This path is tested only on synthetic
  files.
- **Headers and footers in RTF and DOCX are not read.** A transcript whose page numbers exist only in a
  header field gets inferred page numbers, flagged as such.
- **Metadata** (case caption, date, reporter) is not extracted into fields; it stays as testimony
  lines on the cover page. The witness and date come from the upload form, as before.
- **Hidden text, tracked insertions and text boxes in DOCX:** hidden text is read like any text,
  tracked insertions are read, deletions are not, text boxes are left out with a warning.
- **Continuous line numbering across pages** (1–50 on two pages) is not recognised as page:line; such
  text is read as unnumbered, cited by line.
- **Windows-1252 is assumed** for text that isn't UTF-8; other single-byte encodings would read with
  wrong accented letters (a warning says the file was read as Windows-1252).
