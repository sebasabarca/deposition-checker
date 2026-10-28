# Parser spike: Ellison P3171 and P3173

October 27, 2026. Wednesday-morning task from `DESIGN.md` (Ingestion, step 1), run early, then repeated on a second document.

## Summary

**Decision (October 27): `pdfjs-dist` is provisionally accepted** as the extraction library for PDFs that have a text layer. The decision rests on two DOJ-typeset Ellison transcripts. It is **not** evidence that the parser works on other deposition formats, such as condensed 4-up court-reporter pages, scans or other publishers' layouts.

| | P3171 | P3173 |
| --- | --- | --- |
| Numbered lines extracted | 3,943 | 1,660 |
| Correct page:line | 3,943 (100%) | 1,660 (100%) |
| Exact text match with the DOJ HTML | 3,899 (**98.88%**) | 1,639 (**98.73%**) |
| Exact match with what the PDF shows (every difference checked) | 3,940 (**99.92%**) | 1,660 (**100%**) |
| Extraction errors | 3 lines with a wide gap shortened to one space; 0 character errors | 0 |
| Exchanges rebuilt / spanning a page break | 533 / 151 | 209 / 57 |
| Exchanges reviewed by hand | 30: 26 correct, 4 with limited boundaries | 22: 22 correct after fixes (18 at baseline) |

**Why the two accuracy figures differ.** The DOJ HTML is a separate rendering of the same testimony, and it contains its own errors: "would rum to page 57" where the PDF says "turn", "Ido" where it says "I do", single hyphens where the PDF prints "--", and tabs and double spaces the PDF does not show. Measured against the HTML, every one of those counts against the parser even when the parser read the PDF correctly. So I checked each of the 65 differences (44 in P3171, 21 in P3173) against an image of the PDF line. Only 3 were extraction errors, all whitespace and all in P3171. The HTML comparison (98.88% and 98.73%) is the automatic, independent measure. The PDF-grounded figure (99.92% and 100%) is the accuracy of extraction itself, but it depends on a manual check. Both are kept.

The P3173 baseline ran the parser unchanged. Every line and page:line came out right with no layout changes. The baseline did expose 3 general gaps, none caused by P3173's layout, and all three are now fixed. P3171 was rerun after the fixes and its line results are identical.

## Data

| File | Source | SHA-256 |
| --- | --- | --- |
| `ellison/p3171.html` | [DOJ, P3171 web page](https://www.justice.gov/atr/p3171-cid-022793-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript) | `87e242ea…dfd002` |
| `ellison/p3171.pdf` | [DOJ, P3171 PDF](https://www.justice.gov/atr/cases/f204400/204418.pdf) | `1c18756b…0cbe63` |
| `ellison/p3173.html` | [DOJ, P3173 web page](https://www.justice.gov/atr/p3173-cid-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript) | `9a377992…5a39a` |
| `ellison/p3173.pdf` | [DOJ, P3173 PDF](https://www.justice.gov/atr/cases/f204400/204419.pdf) | `3a259658…ce1e` |
| `gates/gates8a–f.pdf` (5 files), `gates/sep2.html` | [DOJ, Gates deposition page](https://www.justice.gov/atr/cases/ms_gates2.htm) | printed by the download script |

**Reproduce:** run `scripts/spike/download.sh`. Then, for each of `p3171` and `p3173`, run `npx tsx scripts/spike/run.ts <doc>` and `npx tsx scripts/spike/render-mismatches.ts <doc>`. Finally run `npx tsx scripts/spike/overlap.ts`. Downloads go to `data/raw/` and outputs to `data/spike-output/<doc>/`. Both folders are gitignored.

## Method

1. **Reference text from HTML** (`html.ts`). Each DOJ table row becomes `{ page, line, text }`. A `<td colspan="2">` row sets the printed page. Unnumbered rows are redacted lines and are skipped; any of those that still contain text are reported as anomalies (there were none in either document).
2. **PDF extraction** (`pdf.ts`). pdfjs text items are grouped into rows by vertical position and joined with a space only where there is a horizontal gap. The topmost five-digit number is the printed page, and the footer is removed. Each row must start with a line number from 1 to 25; rows that don't are reported. A page with no text is recorded as `needsOcr`. A page whose only text is the header or footer is recorded as a blank page.
3. **Two checks on page:line.** The line number read from the text is compared with the line slot implied by the row's position. The sequence of printed pages is compared with the HTML's, skipping blank pages.
4. **Comparison** (`compare.ts`). Lines are matched on printed page:line. A line counts as a match only if its text is identical after trimming the start and end; case, punctuation, quote characters and internal spacing must all match. Every difference is put in a category (`missing_in_pdf`, `extra_in_pdf`, `internal_whitespace`, `typography`, `text`), but no category ever counts as a match.
5. **Checking each difference.** `render-mismatches.ts` draws every differing PDF line next to the HTML text, and I compared each one by eye.
6. **Exchanges** (`exchanges.ts`). Turn markers come from the PDF indent position. Exchanges are rebuilt from them and cross-checked against turn markers read from the HTML's leading spaces. Sampled exchanges were reviewed by hand.

The layout values (where line 1 sits, the line spacing, the header and footer zones, and the turn-indent threshold of x = 118) were measured on P3171 and **not changed** for P3173. Lines per page (22 in both) is read from the data.

## P3171 results

| Measure | Result |
| --- | --- |
| Printed pages, PDF and HTML | 211 and 211; same order |
| Numbered lines, PDF and HTML | 3,943 and 3,943; 0 missing, 0 extra |
| Line number matches line position | 3,943 / 3,943 |
| Exact text match with the HTML | 3,899 / 3,943 (98.88%) |
| Differences | 44: 32 `internal_whitespace`, 12 `text` |

| Who differs from the PDF page | Lines | Details |
| --- | --- | --- |
| HTML, text error | 12 | "--" written as one hyphen ×5, missing spaces around "--" ×3, "rum" for "turn" (163:12), "database." for "data base." (260:7), missing "." (11:4), missing "But" (276:10) |
| HTML, formatting only | 29 | Tabs after "Q." or "A." (26) and double spaces (3), where the PDF shows ordinary spacing |
| Extraction, whitespace | 3 | 141:8, 236:11, 252:18: a wide gap ("zero   There's") returned as one space |
| Extraction, characters | 0 | |

**Exchanges:** 533 rebuilt and 151 span a page break. Turn markers: 522 Q, 527 A, 7 colloquy, 1 new examiner, 2 parentheticals. 5 lines disagree with the HTML's turn markers; all 5 are HTML indentation inconsistencies. Flags: 38 end at a redaction gap, 10 start mid-turn, 6 questions have no answer, 11 answers have no question. The longest answer is 66 lines.

**Manual review: 30 exchanges.** 26 are correct and 4 have limited boundaries. None has a text or page:line error.

| # | Exchange | Case | Verdict |
| --- | --- | --- | --- |
| 1 | p.11:22–12:7 | Spans a page break | Correct |
| 2 | p.83:17–84:5 | Answer after a gap; question redacted | Correct, flagged `no_question` |
| 3 | p.145:13–146:1 | Spans a page break | Correct |
| 4 | p.201:22–202:10 | Spans a page break | Correct |
| 5 | p.264:21–265:1 | Spans a page break, "Too expensive." | Correct |
| 6 | p.8:14–20 | `BY MR. SCOTT:`, multi-paragraph question, "Yes, I do." | Correct |
| 7 | p.9:1–12 | Three-paragraph question, "I've finished." | Correct |
| 8 | p.11:3–4 | "I do." | Correct |
| 9 | p.11:5–13 | "Right." | Correct |
| 10 | p.137:15–139:8 | Objection by Mr. Rill and response, then the answer; 3 pages | Correct |
| 11 | p.220:10–11 | Interrupted question, then "MR. RILL: Let him answer, please." | **Limited:** the next line, "MR. SCOTT: Q. Go right ahead.", starts a new exchange and takes the answer |
| 12 | p.247:1–6 | Question abandoned during colloquy | **Limited:** boundary correct, but the "answer" is "THE WITNESS: Page number?", a clarifying question |
| 13 | p.283:3–8 | Question answered by counsel in colloquy | Correct, flagged `no_answer` |
| 14 | p.244:22–245:1 | Question, then "(Marked Deposition Exhibit No. 17)" | Correct; the exhibit note stays with the earlier exchange |
| 15 | p.246:10–11 | Same, Exhibit 18 | Correct; same note |
| 16 | p.74:16–21 | "MR. SCOTT: Q. You can answer the question." | **Limited:** an instruction labelled "Q." takes the answer away from the real question |
| 17 | p.84:6–11 | "MR. SCOTT: Q. Has any work been done…" | Correct |
| 18 | p.139:9–22 | "MR. SCOTT: Q." after an answer | Correct |
| 19 | p.152:1–14 | "MR. SCOTT: Q." after a break | Correct |
| 20 | p.48:8–16 | Starts mid-question after a gap | Correct, flagged `starts_mid_turn` |
| 21 | p.77:18–78:5 | Starts mid-question after a gap, crosses a page | Correct, flagged |
| 22 | p.9:13–14 | Question whose answer is redacted | Correct, flagged |
| 23 | p.83:7–11 | Question whose answer is redacted | Correct, flagged |
| 24 | p.236:5–21 | Answer marker with no period ("A     They're") | Correct |
| 25 | p.193:20–194:14 | Question paragraph starting with the word "A" ("A couple of them…") | Correct, not read as an answer |
| 26 | p.148:15–151:15 | 66-line answer across 4 pages | Correct |
| 27 | p.91:21–22 | "Q. Yes, sir." / "A. Couple years." | **Limited:** crosstalk; the real question starts at 91:14 |
| 28 | p.195:14–17 | Short answer that repeats the question's words | Correct |
| 29 | p.263:1–11 | Ordinary | Correct |
| 30 | p.309:7–13 | Ordinary, "Correct, but…" | Correct |

The P3171 review caught a bug, which is fixed: "MR. SCOTT: Q. …" lines, where the attorney resumes questioning after colloquy, had been read as colloquy.

## P3173 results

### Baseline: parser unchanged

| Measure | Result |
| --- | --- |
| Numbered lines, PDF and HTML | 1,660 and 1,660; 0 missing, 0 extra |
| Line number matches line position | 1,660 / 1,660 |
| Exact text match with the HTML | 1,639 / 1,660 (98.73%) |
| PDF pages / HTML printed pages | **108 / 99** |
| Page-sequence check | **36 mismatches** |
| Exchanges | 209: 207 `qa`, **2 `colloquy`** |
| Exchanges reviewed (22) | **18 correct, 4 wrong** |

### What failed, and why

| Problem | Cause | General or specific to P3173? | Fix |
| --- | --- | --- | --- |
| 9 PDF pages with no transcript lines | PDF pages 64–72 are blank apart from the footer (rendered and checked). They sit between printed pp. 98 and 114, where testimony is redacted. The parser found no lines on them, which is correct, but it didn't report them. | General: blank pages are a normal part of exhibit PDFs, and silently ignoring them breaks the rule that nothing is dropped without being reported | `pdf.ts` reports them as `blankPages`, separately from `needsOcr` |
| 36 page-sequence mismatches | The check compared PDF pages to HTML pages by position, so 9 blank pages shifted every page after them | General: a flaw in the check, not in extraction | `run.ts` skips blank pages before comparing sequences |
| Witness answers labelled colloquy (3 exchanges) | During colloquy the witness answers as "THE WITNESS: They are probably slightly larger…", which was treated as colloquy, so the witness's words were left out of `answer` | General: P3173 has more of these (3) than P3171 (1), which is why it surfaced here | `THE WITNESS:` turns are now answer turns |
| Fragment labelled `colloquy` (p.33:5–7) | A fragment that starts mid-turn after a redaction gap had no Q or A turn, so it fell through to `colloquy` | General | Such fragments are now `qa`, still flagged `starts_mid_turn` |

No layout value had to change. The line positions, header and footer zones and turn-indent threshold measured on P3171 also fit P3173. The footer text differs ("Ellison 05-23-04" against "01-20-04") but is removed by position, not by content.

### After the fixes (both documents rerun)

| Measure | P3173 | P3171 (rerun) |
| --- | --- | --- |
| Exact text match with the HTML | 1,639 / 1,660 (98.73%), unchanged | 3,899 / 3,943 (98.88%), unchanged |
| Page-sequence mismatches | 0 | 0 |
| Blank pages reported | 9 (PDF pages 64–72) | 0 |
| Exchanges | 209, all `qa`; 57 span a page break | 533, unchanged |
| Turn markers | 206 Q, 209 A, 7 colloquy, 4 new examiner, 0 parenthetical | One change: "THE WITNESS: Page number?" (p.247:4) is now an answer |
| Turn markers disagreeing with HTML | 0 | 5 (HTML indentation) |
| Flags | 32 end at a gap, 2 start mid-turn, 2 no answer, 2 no question | 38, 10, 6, 11 |
| Longest answer | 52 lines | 66 lines |

**The 21 differences from the HTML, each checked against the rendered PDF:**

| Who differs from the PDF page | Lines | Details |
| --- | --- | --- |
| HTML, text error | 7 | "--" written as one hyphen ×5, "cellphone" for "cell phone" (17:1), "Ido" for "I do" (138:13) |
| HTML, formatting only | 14 | Tabs after "Q." or "A." (8) and double spaces (6), where the PDF shows ordinary spacing |
| Extraction | 0 | |

**Manual review: 22 exchanges.** All 22 are correct after the fixes, and none has a text or page:line error.

| # | Exchange | Case | Verdict |
| --- | --- | --- | --- |
| 1 | p.7:22–8:3 | Spans a page break | Correct |
| 2 | p.25:22–27:6 | One-line question, answer across 3 pages | Correct |
| 3 | p.55:19–56:6 | Spans a page break | Correct |
| 4 | p.74:10–76:13 | Three-paragraph answer across 3 pages | Correct |
| 5 | p.130:20–133:7 | 4 pages, ends at a gap | Correct, flagged |
| 6 | p.8:4–5 | "Yes." | Correct |
| 7 | p.8:6–8 | "Yesterday." | Correct |
| 8 | p.13:1–8 | Two-paragraph question, "Yes, I do." | Correct |
| 9 | p.13:12–16 | Interrupted question ("descriptors --"), "Yes." | Correct |
| 10 | p.37:18–38:5 | Witness answers as "THE WITNESS:" after a gap | Wrong at baseline (`colloquy`); correct after the fix, flagged `no_question` |
| 11 | p.71:3–22 | Answer, then Mr. Wall and Mr. Scott clarify "that", then "THE WITNESS:" continues | Wrong at baseline (witness's words left out of the answer); correct after the fix |
| 12 | p.161:2–15 | "We're definitely --", colloquy defining "the market", then "THE WITNESS:" answers | Wrong at baseline (same); correct after the fix |
| 13 | p.33:8–19 | `BY MR. SCOTT:`, then Q and A | Correct |
| 14 | p.33:5–7 | Fragment after a redaction gap | Wrong at baseline (`colloquy`); correct after the fix (`qa`, `starts_mid_turn`). Speaker unknown, so there is no question or answer text |
| 15 | p.160:9–12 | Starts mid-question after a gap | Correct, flagged |
| 16 | p.37:14–15 | Question whose answer is redacted | Correct, flagged |
| 17 | p.72:10–11 | Question whose answer is redacted | Correct, flagged |
| 18 | p.218:10–220:14 | 52-line answer across 3 pages | Correct |
| 19 | p.36:7–9 | "Right." | Correct |
| 20 | p.66:14–17 | "Windows Event Server." | Correct |
| 21 | p.125:17–20 | "It would be duplicative." | Correct |
| 22 | p.221:18–21 | "No, I don't." | Correct |

### How P3173 differs from P3171

- **9 blank pages** in the PDF. P3171 has none.
- **Witness speech during colloquy** is more common: 3 "THE WITNESS:" answers against 1.
- **No wide-gap whitespace loss**, so 0 extraction differences, against 3 in P3171.
- **Smaller:** 99 printed pages (pp. 7–222) against 211. 4 examiner changes and no exhibit-marking parentheticals.
- **Same layout:** 22 lines per page, the same line positions and indents, and a footer that differs only in its date.

## Is the P3171 / P3173 pair suitable as the real-testimony dataset?

| Condition | Finding |
| --- | --- |
| Separate sessions, same witness | **Yes.** In P3173 the examiner says Ellison's earlier deposition was taken on "January 20th, 2004" (p.114:17), which matches P3171's footer ("Ellison 01-20-04"). P3173 was taken later the same year ("This year", p.114:18–19). Other differences: P3171 is under Civil Investigative Demand No. 022793 with exhibits 1–18 and Mr. Rill defending; P3173 uses Exhibit 550 with Mr. Wall defending. P3173's own date is **not stated** in the transcript. Its footer reads "05-23-04", but May 23, 2004 was a Sunday, so that may be a file date. |
| Usable text layers | **Yes.** All 310 pages with testimony (211 + 99) have a text layer, and all 5,603 lines extracted with correct page:line. |
| Suitable page:line structure | **Yes.** Printed page:line on every page, 22 lines per page, consistent between PDF and HTML. Both are designated excerpts with redaction gaps: 70 exchanges end at a gap and 12 start mid-turn after one, all flagged. |
| Enough subject overlap | **Partial.** 213 topic terms appear in at least 3 exchanges of each document. Strong shared subjects: competing with Microsoft (51 / 55 lines), SAP (76 / 23), IBM (8 / 35), Oracle's scale and pricing. The top-ranked pair (P3171 p.148:15 and P3173 p.130:20) is the same argument about scale and fixed costs, given consistently both times. But P3171 centres on PeopleSoft, discounts and maintenance fees (210 / 13 PeopleSoft lines; 51 / 0 discount lines), while P3173 centres on middleware, Web Services and the data hub (0 lines in P3171 for each). P3173 asks what Ellison knew about the data hub at his January 20 deposition, but the P3171 excerpts never mention it. |

**Assessment:** suitable for measuring retrieval, false-positive handling and uncertainty handling, which the evaluation plan already measures on real testimony. Genuine contradictions are likely to be few. `DESIGN.md` already rates that risk High and relies on synthetic fixtures for contradiction precision, so it doesn't change the plan. The overlap measure is a word-overlap check for this decision only, not retrieval.

### Changes to `DESIGN.md` (approved and applied October 27)

The smallest changes that make the plan match the data:

1. **Test data (lines 506–511):** make Ellison P3171 (January 20, 2004) and P3173 (a later 2004 session) the primary real testimony. Keep Gates in the table, described as image-only (109 scanned pages, no text layer), recorded as `needs_ocr`, not processed, and not OCR'd.
2. **Acceptance criteria, real depositions (line 465):** change "at least one full Gates session" to "both Ellison sessions, P3171 and P3173".
3. **Ingestion (lines 56–58):** mark the parser spike done, with `pdfjs-dist` provisionally chosen and a pointer to this report. Add to step 2 that pages with only a header or footer are counted as blank pages, separately from `needs_ocr`.
4. **Build plan (lines 532–535):** replace "Gates" with "Ellison" in the Wednesday to Friday end-of-day checks ("two Gates sessions" becomes "P3171 and P3173").
5. **Evaluation and tests (lines 270, 444, 547, 549):** "Gates and Ellison" becomes "Ellison P3171 and P3173", and the `readAnswer` unit tests use real Ellison answers.
6. **UI example citation (line 496):** `Gates 8/27/98 p.112:4 vs 9/2/98 p.604:17` becomes an Ellison example, for instance `Ellison 1/20/04 p.148:15 vs P3173 p.130:20`.

Nothing else in the design depends on Gates.

## Gates

All 5 Gates PDFs on the DOJ page are scans: **109 pages, 0 with a text layer**. They are excerpts "as admitted in court", not the full 684-page deposition. The Gates Sep 2 HTML page holds a cover page and about one page of testimony, with no printed page numbers. These files are kept as the documented image-only case: ingestion would mark every page `needs_ocr` and report it. OCR is not added.

## Limitations

- **Two documents from one source.** Both PDFs are DOJ-typeset from text, with one column and one text item per line. The accuracy figures do not predict results on court-reporter PDFs, condensed 4-up pages, scans or other layouts.
- **The layout values are fixed numbers measured on P3171:** where line 1 sits, the line spacing, the header and footer zones, and the turn-indent threshold. They held for P3173, but production ingestion should either derive them per document or treat any position-check disagreement as a failure to report.
- **The manual check uses pdfjs's own renderer.** Drawing glyphs and mapping them to text are separate code paths, but they come from the same library.
- **Wide gaps between words become one space.** No characters are lost.
- **Exchange boundaries follow the reporter's markers, not the meaning.**
  - Instructions labelled "Q." ("Go right ahead") and crosstalk separate a question from its answer.
  - A clarifying question from the witness ("Page number?") counts as an answer.
  - Exhibit notes attach to the earlier exchange.
  - A fragment after a redaction gap has no known speaker.
  - The `DESIGN.md` 40-line split is not implemented; the longest answers are 66 and 52 lines.
- **The HTML reader depends on DOJ's table markup.** The HTML turn cross-check uses leading spaces, which the HTML applies inconsistently.
- `render-mismatches.ts` uses `@napi-rs/canvas`, which pdfjs installs as an optional dependency, not a declared one.

## Ready for production ingestion?

**Yes, for text-layer PDFs with this structure, provided two things come first:**

1. **Your approval of the dataset change** (the proposed `DESIGN.md` edits above), because the Wednesday-afternoon to Friday plan and the acceptance criteria currently assume Gates.
2. **The spike's checks become ingestion's validation gates, not just measurements.**
   - Per page, `ingest/` should verify that line numbers match line positions, that printed pages are present and in order, that no rows are unnumbered, and that each page is accounted for as having text, `needs_ocr` or blank.
   - Any failure should mark the deposition as needing review instead of passing silently. That is the safeguard for formats the spike has not seen.

What carries into production: `html.ts`, `pdf.ts`, `compare.ts` and `exchanges.ts` are pure functions with 14 unit tests and can move into `ingest/` largely as they are. What is still missing: per-document layout values, the 40-line answer split, storing the speaker of unknown-speaker fragments, and the database, which is out of scope for the spike.

## Files

- `scripts/spike/download.sh`: downloads the sources and prints SHA-256 hashes
- `scripts/spike/html.ts`, `pdf.ts`, `compare.ts`, `exchanges.ts`: pure parsing and comparison logic
- `scripts/spike/run.ts <doc>`: runs the spike and writes `data/spike-output/<doc>/` (`summary.json`, `mismatches.json`, `turn-disagreements.json`, `exchanges.json`, `exchange-sample.md`)
- `scripts/spike/render-mismatches.ts <doc>`: contact sheets of every differing line
- `scripts/spike/overlap.ts`: the P3171 / P3173 subject-overlap check (`data/spike-output/overlap.md`)
- `tests/spike.test.ts`: 14 unit tests
- New dependency: `pdfjs-dist` 5.4.624
