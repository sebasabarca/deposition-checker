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

### October 28, 2026 — Upload endpoint and background ingest worker

**Branch:** `feature/production-ingestion`.

**Goal:** Ingest uploaded PDFs in a background job, so no request waits on parsing (`DESIGN.md`, Ingestion step 5, deferred from Step 4).

**Developer decisions (approved before implementation):**

1. `validation` and `page_count` are nullable while a deposition is processing; no placeholder values.
2. Ingestion progress is the deposition's status (`processing` → `ready` / `needs_review` / `unsupported` / `failed`). pg-boss runs and retries the jobs. The analysis `jobs` and `job_stages` tables are not built yet.
3. A new `failed` status with `ingest_error`, for system failures only. 3 attempts with backoff. A failure never overwrites a ready deposition or deletes evidence.
4. A duplicate upload returns the existing deposition without queuing again. A failed deposition is re-queued only through an explicit retry endpoint.
5. **Node upgrade (decided during implementation):** pg-boss 12 requires Node 22.12+, and the machine ran Node 20.18. Node 20 reached end-of-life in April 2026. The developer chose to upgrade Node rather than downgrade to pg-boss 10, which has no heartbeats and doesn't pass the original error to the dead-letter queue. `.nvmrc` selects Node 24, which was already installed through nvm, and `package.json` declares `engines: >=22.12`. The 151 existing tests passed on Node 24 before anything was built on it.

**What was built:**

- **Migration `0002`:** the `failed` status, the `ingest_error` column, and nullable `page_count` and `validation`. Two checks: a read file has both a page count and a validation report, and only `processing` or `failed` may have neither; `ingest_error` is set exactly when the status is `failed`. The checks compare the status as text, so the migration can run in the same transaction that adds the new enum value. It applied cleanly to the development database, which already held the ingested depositions.
- **`server/src/api/`:**
  - `POST /api/cases/:caseId/depositions?witness=&takenOn=` with the PDF as the request body (`express.raw`, 50 MB). It checks the bytes for `%PDF-` instead of trusting Content-Type, stores the file, and then, in one transaction under the same advisory lock as `saveDeposition`, either returns the existing deposition (200) or creates the witness and a `processing` deposition and queues the job (202).
  - `GET /api/depositions/:id`: status, error, page counts, reasons and stored counts. Fields that are null while processing stay null.
  - `POST /api/depositions/:id/retry`: locks the row; only a `failed` deposition goes back to `processing` with a new job. Anything else gets 409.
  - JSON errors for 400, 404, 409, 413, 415 and 500.
- **`server/src/jobs/`:**
  - `queue.ts`: the two queues and their settings. The ingest queue makes 3 attempts with exponential backoff from 10 seconds and has a 30-second heartbeat. The dead-letter queue retries for about 3 hours.
  - `enqueueIngest()`: queues a job on the caller's transaction connection (pg-boss's `db` option), so a deposition row is never committed without its job, or a job without its row.
  - `ingest.ts`: `runIngestJob()` does nothing unless the deposition is still `processing`. Otherwise it reads the stored file, checking its hash, then runs `readDeposition()` and `saveDeposition()`. `recordIngestFailure()` changes a deposition only while it is still `processing`.
- **`server/src/db/client.ts`:** `withTransaction()` gives one connection both a Drizzle handle and the raw client.
- **Processes:** `server/src/worker.ts` is the separate worker (`npm run worker`, and `npm run dev` now starts it too). `server/src/index.ts` mounts the v2 routes when Postgres is reachable; otherwise it logs a warning and serves v1 alone.
- **Reused unchanged:** `storeUpload`, `readDeposition`, `saveDeposition` (with its evidence-preserving and locking rules), and v1's endpoints. New helpers in `uploads.ts`: `isPdf()` and `readUpload()`.

**How each failure case is handled:**

- **Bad PDF vs. system failure:** `readDeposition()` never throws for a bad file; it returns `unsupported` or `needs_review`, which is stored. Only system failures throw, and only those are retried and can end as `failed`.
- **Worker crashes mid-job:** pg-boss stops getting heartbeats and retries the job within about 30 seconds. `saveDeposition()` is one transaction, so a crash leaves either nothing or a finished deposition.
- **Worker finishes but crashes before acknowledging the job:** pg-boss runs the job again. The handler sees the deposition is no longer `processing` and does nothing.
- **Last attempt fails:** pg-boss moves the job to the dead-letter queue, with the last error. Its worker writes `failed` and the error, only if the deposition is still `processing`.
- **Postgres unavailable:** pg-boss keeps its jobs in Postgres, so nothing is lost while the database is down. Once it's back, an attempt that was cut off is retried or moved to the dead-letter queue. Writing the failure retries for about 3 hours.
- **Concurrent uploads and retries:** uploads share the deposition's advisory lock, so 8 concurrent uploads of one file created one deposition and one job. Retries lock the row, so 3 concurrent retries queued one job.

**Tests:** 22 new.
- `tests/db/ingest-job.test.ts` (9 handler tests): an unreadable PDF is stored as `unsupported`, not failed; a missing or damaged file throws and stays `processing`; a repeated job does nothing; a failure never touches a ready deposition or its lines; recording a failure throws while the database is unreachable and succeeds once it is back; plus P3173 to `ready`.
- `tests/db/api.test.ts` (10 endpoint tests, no worker running, so no parsing ever happens): 202 with a `processing` deposition and one queued job; duplicates; 8 concurrent uploads; checking bytes rather than Content-Type, including a JSON body; 400, 404 and 413 cases; null fields while processing; retry rules and concurrent retries.
- `tests/db/worker.test.ts` (3 end-to-end tests, with a real worker and 1-second backoff): an upload is answered while `processing` and finished in the background; P3173 becomes `ready` with 1,660 lines; a worker pointed at an empty uploads folder fails 3 times (`retry_count` 2), the deposition becomes `failed` with the ENOENT error, and an explicit retry after the fix succeeds.

The test reset now also drops pg-boss's schema and clears its jobs. Deposition IDs restart at 1 in each test, so leftover jobs would otherwise be counted against new depositions; the first endpoint test run failed for exactly that reason. That run also found a real gap: a JSON body is parsed by the server-wide `express.json()` before the upload route sees it, and got 400 instead of 415. Fixed.

**Results:** all 173 tests pass with Postgres running, and the database tests passed in 3 more repeated runs. Without Postgres, 124 pass and 49 skip. Typecheck is clean.
- **Real processes:** a server and worker run against the development database. A new upload got 202 in 23 ms while `processing`, and the worker then stored it as `unsupported` (60 pages need OCR). That demonstration row was deleted afterwards. Re-uploading P3171 returned the existing `ready` deposition. A Markdown file labelled as a PDF got 415. v1's `/api/samples` still works.
- **Concurrent startup:** three processes starting pg-boss and creating the queues at once on a fresh database worked in 5 of 5 rounds.

**Limitations:**
- Cases are still created only from the CLI or seed data. The upload takes a witness by name and creates it if needed.
- A duplicate upload under a different witness name returns the existing deposition with its original witness.
- `isPdf` only screens out other file types; whether a PDF is usable is decided by the worker.
- Leftover temporary upload files from crashes are not cleaned up yet.
- The worker processes one job at a time, since pdfjs parsing is CPU-bound.

**Codex review:** Confirmed the transactional queuing (a job was invisible outside the transaction before commit, and a rollback removed both the job and the deposition). Found two problems Claude had missed. Both were reproduced against the code before fixing, with a script that ran the handlers in the failing order:

1. **A parser upgrade left queued depositions processing forever (P1).** The worker saves with its own `PARSER_VERSION`, which is part of the deposition key. A deposition queued under an older version was therefore saved as a new deposition, the job completed, and the original stayed `processing` and couldn't be retried. Reproduced: deposition 1 (`r0`) stayed processing and the result became deposition 2 (`r1`). Fixed in `runIngestJob()`: a `processing` deposition has no lines, so its version only names the expected parser. Under the advisory lock for the worker's version, the deposition takes that version and is ingested in place. If that file is already stored under the worker's version, the queued one is marked `failed` with a pointer to the existing deposition. As a final guard, a save that lands on a different deposition throws, so the job is retried and ends as `failed` rather than completing.
2. **A redelivered failure could fail a newer retry (P2).** Failure messages identified only the deposition, and "still processing" can't tell the original run from a retry. Reproduced: the old message marked the retried deposition `failed`. Fixed with migration `0003`: `ingest_run`, 1 at upload, incremented by each explicit retry. Every job carries the run it was queued for (`{ depositionId, run }`), and both `runIngestJob()` and `recordIngestFailure()` act only on the current run. A stale job is skipped, and a stale failure changes nothing.

The same script after the fixes: one deposition, ingested in place; the stale failure was ignored and the retry stayed `processing`. 4 new handler tests: adopting the worker's parser version; the duplicate case marked failed with a pointer; a stale failure and a stale job ignored while the retry's job does the work; and the retry's own failure still recorded. The endpoint test checks that a retry starts run 2. All 177 tests pass, the database tests passed 2 more repeated runs, and typecheck and `git diff --check` are clean. Not covered by a test: the final guard, since no path that reaches it remains after the fix.

**Codex re-review:** Found one more problem (P1): jobs queued before migration `0003` carry only `{ depositionId }`. The worker compared their missing run with the deposition's run 1, so it skipped them, and the deposition stayed `processing` forever with no way to retry it. Claude had considered this case while writing the fix and wrongly dismissed it, on the grounds that no such jobs would exist. Reproduced by calling both handlers with an old-format payload: the job was skipped and the failure wasn't recorded. Fixed by validating every job payload with zod when the worker receives it (`parseIngestJob()` in `jobs/queue.ts`), with a missing `run` read as 1. That is exact rather than a guess: `0003` set every existing deposition to run 1, and only the new retry endpoint increments it. A payload that can't name a deposition and run now throws, so the job fails visibly instead of being skipped. Tests: 3 unit tests for the parser, and 2 end-to-end tests that put old-format jobs into the real queue, one finishing as run 1 and one with its final failure recorded. All 182 tests pass, and typecheck and `git diff --check` are clean.

**Codex third review:** Found two races between overlapping executions of the same job, the kind pg-boss produces when an attempt is given up on but its process keeps going. Both were reproduced deterministically by running the paused execution's steps in the failing order:

1. **A given-up run could save over a newer run (P2).** The run was checked only before parsing. Reproduced: run 1 parsed, was marked failed, run 2 was started by a retry, then run 1 saved. Run 2's deposition became `unsupported`, and run 2's own job then skipped it. Fixed: the worker passes its run to `saveDeposition()` (`onlyIf`). The save re-checks, inside its own transaction and after its advisory lock, with the deposition row locked `FOR UPDATE`, that the deposition is still `processing` that run; otherwise it returns `not_current` and changes nothing. A retry and a recorded failure update that same row, so they wait for an ongoing save, or the save sees them. Every path takes the advisory lock before the row lock, so they can't deadlock. The save also throws if its result would land on another deposition. That guard moved into the transaction, and is now tested.
2. **Overlapping parser adoptions called a deposition a duplicate of itself (P2).** Reproduced: two attempts read the old version; the first adopted it, and the second found the same deposition under the new version and marked it `failed` as "already stored as deposition 3", itself. Fixed: the duplicate check excludes the deposition's own ID, so the second adoption is a harmless no-op.

3 new handler tests: the given-up run's save returns `not_current` and run 2 still finishes; two adoptions from the same stale snapshot both succeed and the deposition then ingests; a save that would land on another deposition throws and leaves its own `processing`. `adoptParserVersion` is exported from `jobs/ingest.ts` for that test, but not from the module's public entry point. All 185 tests pass, the database tests passed another full run, and typecheck and `git diff --check` are clean.

**Status:** Implemented, tested and reviewed. Awaiting developer approval before commit. Next: the `costs/` price table and `recordCall()` as a separate small step.
