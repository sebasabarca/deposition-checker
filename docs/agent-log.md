# AI Development Log

## Tools

- Claude Code: Planning, implementation, debugging, and testing.
- Codex: Independent code reviews and identifying potential issues.
- Developer: Architecture decisions, implementation approval, and verification.

## Development Sessions

### October 27, 2026 — Project Setup

**Goal:** Prepare the repository for AI-assisted development.

**Activities:**

- Installed and configured Claude Code.
- Prepared the v2 architecture and development plan.
- Established project instructions in CLAUDE.md.
- Created this development log.

**Decisions:**

- Implement features incrementally.
- Review significant changes before implementation.
- Use Codex for independent code reviews.
- Verify AI-generated code through tests and manual inspection.

**Status:** Complete. CLAUDE.md was briefly replaced by the text of the prompt used to write it; it was rewritten to that prompt's spec and restored.

### October 27, 2026 — Parser spike 1: Ellison P3171

**Goal:** Choose a PDF extraction approach before building ingestion (`DESIGN.md`, Ingestion step 1, brought forward from Wednesday).

**Prompt:** Read the Wednesday-morning plan and propose an implementation; then, once approved, run the spike with conditions: verify text and page:line together, avoid normalization that hides errors, manually inspect at least 20 exchanges, keep PDFs out of Git, no production ingestion.

**What happened:**

- Before writing code, Claude downloaded the DOJ files and found the planned Gates PDFs are scans with no text layer (109 pages, 0 with text). The developer approved Ellison P3171 instead, with Gates kept for later.
- Built `scripts/spike/` with `pdfjs-dist`: an HTML reader for the DOJ reference text, a PDF extractor that cross-checks each line number against its position on the page, a line-by-line comparison that only trims line ends, and an exchange builder.
- Results: 3,943 / 3,943 page:line correct; 3,899 / 3,943 (98.88%) exact against the HTML. Every one of the 44 differences was rendered from the PDF and checked by eye: 41 were errors or formatting in the HTML, 3 were extraction errors (a wide gap shortened to one space). Measured against the PDF itself: 3,940 / 3,943 (99.92%).

**What the agent got wrong, and what changed:**

- Said the Gates PDFs were 6 pages each, based on the macOS `file` command. pdfjs counted 13 to 60 pages per file; corrected.
- Classified "MR. SCOTT: Q. …" (attorney resumes questioning after colloquy) as colloquy, which glued exchanges together. Caught in the manual exchange review; fixed and covered by a test.
- Wrote one unit test with the wrong expected value (a question with no answer is correctly flagged `no_answer`); the test was fixed, not the code.
- Miscounted two figures in the first draft of `docs/parser-spike.md`; caught by re-checking the report against the data before handing it over.
- When committing `CLAUDE.md` and `DESIGN.md`, the commit also picked up lockfile changes that were already staged. Claude redid the unpushed commit with only the two documents and left the lockfiles staged.

**Decision:** `pdfjs-dist` provisionally accepted for text-layer PDFs on the PDF-grounded figure, with both figures kept in the report and no claim about other formats.

### October 27, 2026 — Parser spike 2: Ellison P3173

**Prompt:** Run the parser on P3173 with its layout values unchanged, report the baseline first, then make the smallest general fixes and rerun both documents. Check whether P3171 and P3173 are a suitable dataset before proposing `DESIGN.md` changes.

**Baseline (parser unchanged):** 1,660 / 1,660 lines and page:line correct, 98.73% exact against the HTML, but 108 PDF pages against 99, 36 page-sequence mismatches, and 4 of 22 reviewed exchanges wrong.

**What the baseline exposed (all general, none caused by P3173's layout):**

- 9 blank PDF pages (footer only) were ignored without being reported, and the page-sequence check compared pages by position. Fixed: blank pages are reported separately and skipped by the check.
- The witness speaking as "THE WITNESS:" was treated as colloquy, so his words were missing from answers. Fixed: those lines are answer turns.
- A fragment after a redaction gap was labelled `colloquy`. Fixed: labelled as testimony and still flagged.

**After the fixes:** P3173 has 0 extraction differences (all 21 HTML differences are on the HTML side) and 22 / 22 reviewed exchanges correct. P3171's line results are unchanged.

**Dataset check:** P3173 refers to the earlier deposition as taken on January 20, 2004, matching P3171, so they are separate sessions of the same witness. Subject overlap is partial (Microsoft, SAP, IBM, pricing and scale). Genuine contradictions are not assumed.

**Decisions (developer):** Ellison P3171 and P3173 become the primary real documents; Gates stays documented as the image-only limitation, with no OCR. The six `DESIGN.md` edits were approved and applied.

### October 27, 2026 — Codex review

Codex reviewed the parser-spike changes and found no actionable bugs within the spike's scope.

**Status:** Parser spike complete. Production ingestion plan proposed and awaiting approval.

### October 27, 2026 — Production ingestion, Steps 1 and 2

**Branch:** `feature/production-ingestion`, created from `main` after the parser spike was merged.

**Goal:** Turn the validated spike into production code in `server/src/ingest/`: PDF → validated source lines → speakers and Q/A exchanges. No database yet.

**Prompts:** Plan production ingestion in small steps and wait for approval; then implement Step 1 (extraction and validation) only, report, and wait for review before Step 2 (speakers, exchanges, long-answer parts).

**Developer decisions recorded in `DESIGN.md`:**

- Every page gets an explicit status (`text`, `blank`, `needs_ocr`, `failed`) and every deposition a status (`ready`, `needs_review`, `unsupported`). Only `ready` depositions are used for analysis; other layouts are reported, not parsed.
- Every extracted line is kept, whether or not it belongs to an exchange. Unknown speakers are kept but never treated as witness testimony.
- Exchange parts store question and answer line ranges plus exact line membership (`exchange_lines`), because the range between two endpoints can include lines that aren't testimony.
- Answers over 40 witness lines split into parts overlapping by 5 lines; only witness answer lines count, and every part carries the full question.
- `question_text` and `answer_text` are derived for retrieval and `dialogue_text` for model input; the source lines stay authoritative for anything displayed.
- PDF input only, stored locally under `data/uploads/` for the demo. CLI ingestion is fine during development, but the upload endpoint and background worker remain required (deferred to the next stage). The full-text index waits for Path B.

**What was built:**

- Step 1: `layout.ts` (the `ellison-doj-v1` profile and `PARSER_VERSION`), `pdf.ts` (extraction ported from the spike), `validate.ts` (per-page checks and statuses), `index.ts` (`readDeposition`). Two checks are stricter than the spike: footer text must look like the DOJ footer, and out-of-range line numbers fail the page instead of being set aside.
- Step 2: `exchanges.ts` (speaker attribution, exchanges with line roles, long-answer parts, derived text). Exchanges are built only for `ready` depositions.
- Results: P3171 and P3173 come out `ready` and reproduce the spike exactly (3,943 and 1,660 lines; 533 and 209 exchanges; 1 and 4 long answers split). All five Gates PDFs come out `unsupported` (109 pages, no text layer). A file that isn't a PDF comes out `unsupported` with the error message.
- 109 tests pass, including a regression test that compares production output with the spike and the DOJ HTML line by line and skips itself when `data/raw/` is absent.

**What the agent got wrong, and what changed:**

- Claude's own review of Step 1 found three problems in its code: an all-blank PDF was `unsupported` with no reason; a misnumbered blank page could pass or get the next page blamed; and `PARSER_VERSION` couldn't change when the parsing logic did, which would break duplicate detection in Step 4. Fixed, with tests. The first fix for the blank-page problem was itself wrong (it still blamed the next page); the new test caught it before it was reported.
- Codex's independent review of Steps 1 and 2 found three bugs Claude had missed:
  1. Model-facing text dropped attorney interruptions and merged separate answers ("No." and "Yes." around an attorney's correction became "No. Yes."). Fixed by adding `dialogue_text`, which keeps every turn in order with a speaker label, and by keeping witness turns separate in `answer_text`.
  2. A multi-word surname ("MR. VAN DYKE:") was attributed to the witness, and any unrecognized label inherited the previous speaker. Fixed: multi-word names are recognized, and unrecognized labels become `unknown`.
  3. Consecutive numbered blank pages could be out of order and still pass. Fixed with a separate page-order baseline for blank pages.
- Codex's re-review found the fix for finding 2 incomplete: a label alone on its line ("COURT REPORTER:") still inherited the witness, because the patterns required a space after the colon. Claude fixed it, and also found and fixed the same flaw in the `THE WITNESS:` and `MR. X: Q.` patterns. Fixing only the first would have excluded the witness's own testimony.
- Every fix was first reproduced with a failing test. None changed exchange counts or speaker attribution on the Ellison PDFs. Only the derived answer text of 3 P3173 parts changed, now keeping interrupted answers as separate turns.

**Codex review:** Found the issues above; its targeted re-review confirmed all fixes resolved.

**Status:** Steps 1 and 2 complete and approved, ready to commit. Next: Step 3, PostgreSQL setup with Docker Compose and Drizzle.
