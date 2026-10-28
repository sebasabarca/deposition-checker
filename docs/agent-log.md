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

### October 28, 2026 — Production ingestion, Step 3

**Branch:** `feature/production-ingestion`.

**Goal:** Set up PostgreSQL with Docker Compose and Drizzle, and create the tables ingestion needs. Nothing writes to them yet; saving `readDeposition` results is Step 4.

**What was built:**

- `docker-compose.yml`: Postgres 16 from the `pgvector/pgvector:pg16` image, data in a named volume, and a health check so `npm run db:up` waits until the database is ready. `docker/postgres-init/` creates a separate `deposition_checker_test` database the first time the volume is created, so tests never touch development data.
- `server/src/db/schema.ts`: seven tables (`orgs`, `cases`, `witnesses`, `depositions`, `lines`, `exchanges`, `exchange_lines`). `client.ts` opens the connection from `DATABASE_URL`. The first migration is `drizzle/0000_init_ingestion.sql`.
- New dependencies: `drizzle-orm` and `pg` (runtime), `drizzle-kit` and `@types/pg` (development). New scripts: `db:up`, `db:down`, `db:generate`, `db:migrate`. `.env.example` and `CLAUDE.md` list the new variables and commands.

**Rules the database enforces:**

- Duplicate protection: one deposition per case, file hash and parser version (`DESIGN.md`, "Idempotent by design"). A new parser version may ingest the same file again.
- One line per `page:line` in a deposition, and one row per exchange part.
- A deposition's witness must belong to the same case.
- File hashes must be 64 hex characters, statuses must be known values, part numbers must be in range, question and answer ranges must have both endpoints or neither, and a part holds at most 40 answer lines.
- Exchanges point at lines by ID and never copy them. Overlapping long-answer parts share lines through `exchange_lines`.
- An exchange, and each of its `exchange_lines` rows, can only point at lines from its own deposition. The foreign keys cover the pair (line, deposition), the same pattern as witness and case.
- Deleting a deposition removes its lines, exchanges and memberships, but not its case or witness. This is what lets Step 4 rewrite a deposition cleanly.
- Not yet included: the full-text `tsv` column and its index (Path B), plus the tables for retrieval, jobs, findings and users, which arrive with their own modules.

**What the agent got wrong, and what changed:**

- Codex's review found that the foreign keys only checked that a referenced line existed, not that it belonged to the exchange's deposition. An exchange could cite another witness's line, even from another case, and display it as that witness's evidence. Claude had missed it. A new test reproduced it against the old schema (the database accepted the cross-deposition exchange). Fixed with composite foreign keys on the six exchange endpoints, plus a `deposition_id` column on `exchange_lines` with keys to both the exchange and the line. The migration had not been committed, so `0000_init_ingestion.sql` was regenerated rather than adding a second one.

**Tests:** 14 database tests in `tests/db/schema.test.ts` check each rule above against a real Postgres. They run only when `TEST_DATABASE_URL` is set, and refuse to run unless the database name ends in `_test`, so `npm test` still works without Docker. With Postgres running, all 123 tests pass and typecheck is clean.

**Status:** Step 3 complete, ready to commit. Next: Step 4, saving ingested depositions in one transaction keyed by file hash and parser version.

### October 28, 2026 — Production ingestion, Step 4

**Branch:** `feature/production-ingestion`.

**Goal:** Save what `readDeposition()` produces to Postgres, so that re-ingesting the same PDF never duplicates source records (`DESIGN.md`, Ingestion steps 4 and 5).

**Developer decisions (approved before implementation):**

1. Every deposition is stored with its validation report, whatever its status, but only `ready` depositions get lines and exchanges.
2. `witness_id` is added to `exchanges` now, as `DESIGN.md` specifies. Step 3 had left it out without saying so.
3. Re-ingesting keeps the deposition row and its ID, and replaces only its lines and exchanges.

**What was built:**

- `server/src/ingest/rows.ts` (pure): converts lines and exchange parts into rows. In memory, parts refer to lines by position. After the lines are inserted, each position is translated to its stored ID by matching on `page:line` rather than trusting insert order. `norm_text` comes from v1's `normalize()`, so later quote matching uses the same normalization.
- `server/src/ingest/store.ts`: `saveDeposition()` writes everything in one transaction. It locks the previous ingestion of the same case, file hash and parser version, deletes its exchanges and then its lines, inserts or updates the deposition row, and inserts lines, parts and memberships in batches of 1,000. Any failure rolls the whole save back.
- `server/src/ingest/uploads.ts`: stores PDFs as `data/uploads/<sha256>.pdf` (now in `.gitignore`); the storage key is the file name, ready to become an S3 key. `ingestFile()` in `index.ts` stores, reads and saves in one call.
- `scripts/ingest.ts`: the development CLI. It creates the org, case and witness if needed, ingests the file and prints a summary.
- Migration `0001_exchange_witness.sql`: `exchanges.witness_id`, with a foreign key on (deposition, witness) so it always equals the deposition's witness, and the `(witness_id, deposition_id)` index from `DESIGN.md`. Drizzle generated the foreign key before the unique constraint it depends on, which Postgres would reject. The statements were reordered by hand.
- Test setup: the database tests now share `tests/db/database.ts`. `vitest.config.mts` (an `.mts` file because the package is CommonJS) runs test files one at a time, because both database test files reset the same database. The full suite now takes about 3.5 seconds instead of about 1.

**Results with the real PDFs (CLI, development database):** P3171 is `ready`, with 3,943 lines and 533 exchanges in 534 parts. P3173 is `ready`, with 1,660 lines and 209 exchanges in 213 parts; its 9 blank pages are recorded. Both match Step 2 exactly. Ingesting P3173 a second time kept deposition 2 and the same counts. Gates `gates8a.pdf` was stored as `unsupported`, with 13 pages that need OCR, the reason, and no lines.

**Tests:** 9 pure tests for the row mapping, 6 new database tests (saving, re-saving, rollback that leaves the previous ingestion untouched, an unsupported file, a new parser version, and P3173 end to end), and 1 new schema test for the exchange witness rule. All 139 tests pass with Postgres running. Without it, 118 pass and the 21 database tests skip. Typecheck is clean.

**Limitations:**

- The CLI looks up orgs and cases by name, and those names are not unique in the schema. That's fine for one developer; the upload endpoint will take IDs.
- An insert that turns into an update still uses up an ID, so deposition IDs can have gaps (the Gates file got ID 4).
- The upload endpoint, the pg-boss worker and the `processing` status remain for the next stage.

**Codex review:** Found five problems Claude had missed. Each was first reproduced with a failing test, then fixed:

1. **A failed re-ingestion destroyed good evidence (P1).** Re-ingesting a `ready` deposition with an attempt that came out `unsupported` or `needs_review` (a parse that failed this time) deleted its lines and exchanges and overwrote its status. Reproduced: the stored rows went from 5 lines to 0. Fixed: when the stored deposition is `ready` and the new attempt isn't, `saveDeposition()` changes nothing and returns the outcome `kept_previous`, with the failed attempt's validation in `attempt`. A successful re-ingestion still replaces the rows in one transaction and keeps the ID. A first-time failed file is still stored with its validation report and no lines. `replaced: boolean` became `outcome: created | replaced | kept_previous`.
2. **Migration `0001` failed on a database with exchanges in it (P1).** It added `witness_id` as `NOT NULL` in one step. Reproduced with a new migration test that applies `0000`, inserts exchanges for two witnesses, then applies `0001`: "column witness_id contains null values". Fixed by hand in the SQL: add the column as nullable, copy each exchange's witness from its deposition, then require it, then add the foreign key and index. `drizzle-kit generate` still reports no schema changes, so the snapshot matches. The development database had already applied the old `0001` while empty; it ends in the same state, so it wasn't re-run.
3. **Stored PDFs could be partial or corrupted (P1).** An existing file was trusted because of its name, and a second writer could return while the first was still writing. Reproduced: a truncated file under the right name was kept. Fixed: an existing file is used only if its SHA-256 matches its name. Otherwise the upload goes to a unique temporary file in the same folder, is flushed to disk, checked against the hash, and renamed into place. A rename within one filesystem is atomic, so the stored file is always either absent or complete. Concurrent writers each rename an identical copy. Tests cover a corrupted existing file, a leftover temporary file from a crash, and 8 concurrent writers.
4. **Concurrent ingestion of the same file failed (P2).** Two saves could both find no deposition, and the second then inserted its lines over the first's. Reproduced: 7 of 8 concurrent saves failed with `lines_page_line_unique`. With 4 saves the race didn't always happen, so the test opens the pool's connections first and runs 8. Fixed: each save first takes a Postgres advisory lock on its key (case, file hash, parser version), held until its transaction ends. Saves of the same file run one at a time, and each later one sees the earlier one's committed rows and replaces them.
5. **Concurrent CLI runs created duplicate cases (P2).** Reproduced: 8 concurrent lookups created 8 cases with the same name. Fixed without making case names unique: the lookup (moved to `scripts/cases.ts` so it can be tested) runs in a transaction that first takes one advisory lock shared by all CLI lookups, so concurrent runs wait for each other.

The concurrency tests passed in 5 repeated runs. All 151 tests pass with Postgres running. Without it, 124 pass and the 27 database tests skip. Typecheck is clean.

**Known limits that remain:** a temporary upload file left by a crashed process stays in `data/uploads/` (hidden, ignored, and never used as the stored file); cleaning it up is left for the worker stage. The CLI lock serializes every CLI lookup, which is fine at command-line volume.

**Status:** Step 4 and the Codex fixes implemented and tested. Awaiting developer approval before commit.
