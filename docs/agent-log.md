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

### October 28, 2026 — Model cost tracking (`costs/`)

**Branch:** `feature/costs`, from `feature/background-ingestion` (that PR isn't merged yet).

**Goal:** Record every v2 model call with its token counts and cost from a versioned price table, before any model is called (`DESIGN.md`, "Cost model"; on the schedule for Wednesday afternoon). The estimator and the budget guard come with adjudication.

**Prices:** Taken from the live pricing page on October 28. The skill's cached reference gave Sonnet 5.5 cache reads at $0.20 per million tokens; the live page says $0.10 (0.05x input), and the live value is used. Haiku 5.5 has a second price tier for prompts over 100,000 tokens, counting cache reads and writes, and every token in such a request pays the higher rate. The Batch API halves every token type.

**Developer decisions (approved before implementation):**

1. `llm_calls.job_id` is nullable with no foreign key until the `jobs` table exists. That migration adds the key after checking existing values. The type is `bigint`, like every other ID.
2. Separate `cache_write_5m_tokens` and `cache_write_1h_tokens` columns, since the two durations are priced differently. `DESIGN.md` updated.
3. A call to a model missing from the price table is still recorded with its tokens, as unpriced (`cost_usd` and `price_version` null), and never counted as free in totals. A test checks that every configured v2 model has a price.
4. v1's `server/src/claude.ts` stays unchanged and is documented as the one known exception to recording. All new v2 model calls use `recordCall()`.

**What was built:**

- `server/src/costs/pricing.ts`: `PRICE_VERSION` (`2026-10-28`), rates per model in price tiers by prompt length, and the batch multiplier.
- `server/src/costs/models.ts`: the model per stage, `claim_tagging` → Haiku 5.5 and `adjudication` → Sonnet 5.5.
- `server/src/costs/cost.ts` (pure): `tokensFromUsage()` maps the SDK's `usage`; cache writes reported without the 5-minute/1-hour split count as 5-minute, the API's default. `callCost()` picks the tier by prompt length, adds the five token types at their rates, applies the batch discount, rounds to 8 decimals, and returns null for an unpriced model.
- `server/src/costs/record.ts`: `recordCall()` inserts the row. `jobCost()` totals a job by stage; its `totalUsd` is null while any call is unpriced, with the priced part reported separately.
- Migration `0004`: the `llm_calls` table, the `llm_stage` enum, the `(job_id, stage)` index, and checks: non-negative tokens, items and attempt at least 1, cost and price version present together.

**Tests:** 17 new.
- 12 pure: input and output prices, both cache-write durations, cache reads per model, a full mixed call, Haiku at exactly 100,000 and 100,001 prompt tokens including a prompt pushed over by cache reads, the batch discount, an unpriced model, the price version, the usage mapping, every configured model priced, and the stages matching the database enum.
- 5 database: exact persistence of every token count and the cost, a tiny batch cost kept to its last decimal, an unpriced call stored with its tokens, job totals by stage that become unknown once an unpriced call appears, and the table's checks.

The schema test now expects `llm_calls` too. All 202 tests pass on Node 24 with Postgres running; without it, 139 pass and 63 skip. Typecheck and `git diff --check` are clean. Migration `0004` applied to the development database.

**Not built yet:** the estimator, the budget guard, and any model call.

**Status:** Implemented and tested. Awaiting developer approval before commit.

### October 28, 2026 — Path B full-text retrieval, stage 1

**Branch:** `feature/path-b-retrieval`, from `main` after PRs #4 (background ingestion) and #5 (cost tracking) were merged.

**Goal:** Candidate pairs from the original testimony without any model call (`DESIGN.md`, "Candidate retrieval → Path B"), and a preview to label pairs from. This stage builds the index, Path B, bidirectional search, deduplication and ranking, and the preview command. Path A, the `candidates` table, merging and the recall@K evaluation are not built.

**Developer decisions (approved before implementation):**

1. No stored `content_terms` column. It is counted at query time with the current courtroom word list, and `tsv` is a generated column. `DESIGN.md` updated.
2. Retrieval runs in both directions between depositions; pairs are deduplicated keeping the best score and ranked by it. Retrieval relevance is not contradiction confidence.
3. Evaluation labels go in a versioned JSON file under `data/eval/`, anchored by the PDF's SHA-256 and page:line rather than exchange IDs, with a label definition and a short explanation per pair, and no transcript text. Recorded in `DESIGN.md`; the file and the evaluation are the next stage.
4. Only stage 1 now.

**What was built:**

- **Migration `0005`:** `exchanges.tsv`, generated from the question and answer text with Postgres's English configuration, with a GIN index. Applied to the development database, it indexed the 747 existing exchange parts (about 19–20 distinct terms each).
- **`server/src/retrieve/procedural.ts`** (pure): the courtroom word list (procedure and conversational filler that Postgres's English stopwords keep; words that can carry testimony such as "know", "remember" and "said" are kept), `MIN_CONTENT_TERMS = 3`, and `proceduralReason()`: kinds other than `qa`, and name-and-address questions.
- **`server/src/retrieve/rank.ts`** (pure): `rankPairs()` deduplicates matches from both directions into unordered pairs, keeps the best score and every matched term, records which side's query found the pair, and ranks by score with ID tie-breaks.
- **`server/src/retrieve/pathB.ts`:** `findPathB(db, { witnessId, depositionId, mode })`, one SQL statement.
  - The witness's exchanges in ready depositions, minus procedural ones, become queries if they have at least 3 content terms.
  - `all_terms` ORs them all; `rare_terms` ORs the 12 with the lowest frequency across the case's exchanges.
  - Each query searches the other side (the new deposition against the others, and the others against it) and keeps its top 5 by `ts_rank_cd`, with the terms it shared.
  - Terms are quoted into the `tsquery`, so a stemmed term can't be read as query syntax.
  - Counts account for every exchange: procedural, too few terms, or queried.
- **`scripts/pathb.ts`:** a read-only preview of the ranked pairs. Each side shows its deposition, file hash and page:line range, with lines printed from the stored source lines.

**Results on Ellison P3171 against P3173** (development database; 747 exchange parts, 0 procedural since ingestion classified every Ellison exchange as `qa`, 47 too short, 700 queried):
- **all_terms:** 3,401 pairs in about 1.1 s. The top of the list is dominated by long answers sharing generic words (*go, get, one, say, think, lot*), alongside real shared topics such as Microsoft's scale and low prices (P3171 148:15 / P3173 129:17).
- **rare_terms:** 3,201 pairs in about 5 s. It favours short exchanges sharing named products and terms (*outsourcing, e-business suite, database*). Many queries have fewer than 12 terms, so rare-terms and all-terms queries are often identical for short exchanges.
- Rare-terms is slower because it looks up each term's case-wide frequency per query. 5 s is acceptable for a background job, so it is not optimized yet, as the developer asked.
- Which mode is better is for the labelled evaluation to decide, not for this preview.

**Tests:** 13 new.
- 7 pure: the procedural filter, and dedupe and ranking.
- 6 database, on hand-built sessions:
  - shared-subject pairs only across sessions of the same witness, never within a session, with another witness, or with a deposition that isn't ready;
  - top 5 per query, plus a pair only the other direction reaches;
  - procedural and too-short exchanges counted, not queried;
  - courtroom words alone don't make a pair;
  - rare-terms leaving out a pair that shares only a common word;
  - and both modes on the real PDFs: every pair joins the two sessions, every exchange is accounted for, and ranks are contiguous.

Two test mistakes were caught on the first run and fixed in the tests, not the code: the real-PDF test used an invalid placeholder file hash, and the rare-terms test forgot that the other direction's queries could find the common-word pairs. All 215 tests pass on Node 24 with Postgres running; without it, 146 pass and 69 skip. Typecheck and `git diff --check` are clean.

**Developer review of the top 40 rare-terms pairs, and Claude's investigation (before changing anything):**

- **Context.** Pair #2 (P3171 249:13–250:16 / P3173 51:13–51:15): P3171's "To what degree?" follows up 249:10 ("competition from outsourcers change from 2002 to 2003? — Yes, definitely."), so its topic is in the previous exchange. P3171 describes the industry's business-process outsourcing and software-as-a-service, where customers don't buy software; P3173 asks about Oracle's own outsourcing service, where they do, and P3173 51:1–51:12 isn't in the excerpt. They look like different subjects, a good "ambiguous" case to label, and a reminder that evidence packets need the neighbouring context. Pair #37 (P3171 148:15–150:11 / P3173 130:12–130:16): P3171's side is part 1 of a split long answer ending mid-sentence at 150:11.
- **Numbers.** Postgres's parser splits `$10,000,000` into `10` and `000`, and `$10,000` the same way, so #33 "matched" on amounts a thousand times apart. `R&D` and `e-business` fragment similarly.
- **Long exchanges.** Exchange 1521 (in 8 of the top 40) and 207 are first parts of split long answers with 96 and 90 distinct terms; 473 of the 747 parts have fewer than 20. OR queries favour the biggest answers, and split answers multiply them.
- **Performance.** Path B sent 2 statements. `EXPLAIN ANALYZE` showed 5.8 of rare-terms' 6.0 s in one step: Postgres re-evaluated the case-wide frequency table once per query (`loops=735`) because it was inlined into a correlated subquery. The GIN index itself was used for every query at 0.02–0.1 ms each.

**Codex review: four issues, fixed:**

1. **Split exchanges weren't deduplicated.** Parts of the same long answer counted as separate candidates and took separate per-query slots. Retrieval still searches parts, but each query now keeps its top 5 *logical* exchanges (`distinct on (deposition, group)`). Final candidates are deduplicated by the two logical exchanges `(deposition_id, group_id)`, keeping the best-scoring part pair and its part IDs as the exact source references; this happens before any top-K cut. Tests cover split exchanges on both sides.
2. **Scores weren't comparable.** The kept score was the `ts_rank_cd` of whichever query found the pair, and queries with different term sets give incomparable scores. `ts_rank_cd` now only discovers candidates. The final score is computed in pure code from the two exchanges' own terms, so it is symmetric and independent of direction and query length. Measured on Ellison before adopting one, with ranks of #2, #33 and #37 under rare-terms:

   | Score | #2 | #33 | #37 | one-shared-word pairs in top 40 | 1521 in top 40 | mean terms per side, top 40 |
   |---|---|---|---|---|---|---|
   | old `ts_rank_cd` | 2 | 33 | 37 | — | 8 | — |
   | plain Jaccard | 1,196 | 635 | 1,979 | — | 0 | 15.6 |
   | IDF cosine | 279 | 521 | 1,503 | 7 | 0 | 11.0 |
   | IDF cosine, ≥2 shared | 228 | 430 | 1,204 | 0 | 0 | 12.7 |
   | sum of shared IDF | 623 | 374 | 779 | 0 | 6 | 60.9 |
   | **IDF weighted overlap (÷ smaller), ≥2 shared** | **2** | **1,097** | **417** | **0** | **1** | **20.2** |

   IDF cosine was implemented first and rejected after inspecting its top 12: short exchanges sharing one uncommon word (*familiar*, *brand*, *event*) filled it. The weighted overlap coefficient was adopted (`retrieve/score.ts`), because a contradiction is often a short Q/A echoing part of a long answer. A failing test then showed that a word used in every exchange still counted toward the 2-shared-terms minimum; only terms with weight now count.
3. **The CLI picked an arbitrary case.** It now takes `--case-id`. A case name is accepted only when name and witness resolve to exactly one case (otherwise an error listing the case IDs), and `--deposition` must be a ready deposition of the resolved witness and case. No uniqueness constraint on case names. The lookups are `resolveWitness()` and `resolveDeposition()` in `scripts/cases.ts`.
4. **Focused tests.** Below.

**Also changed:**
- The frequency table is computed once per run and passed in, and the rare-term choice moved into the pure `queryTerms()`. Rare-terms went from 4.9 s to 0.3 s with the same queries.
- A regression Claude introduced during the rewrite and then caught: search targets had been limited to parts with 3 or more terms. `DESIGN.md` skips short parts as *queries* only, so they can be found again (3,185 → 3,193 pairs).
- Path B now sends 4 statements. `EXPLAIN ANALYZE` of the search: GIN *Bitmap Index Scan* on every query, 227 ms (rare-terms) and 1.27 s (all-terms).

**Results after the changes:** On Ellison under rare-terms, about half of the new top 20 are substantive topic matches (outsourcing, the e-business suite, HR functionality, a product-replacement denial, database competition). The rest are procedural or filler pairs matching on words not on the courtroom list (*ask, let, clear, take, know*, the fragments *ll*, *re*). The developer asked not to change that list before labels can measure it.

**Labels file:** `data/eval/ellison-labels.json`, version 1. Both depositions are identified by full SHA-256. It has label definitions, a separate `retrievalRelevant` yes/no for recall@K, and an empty `pairs` list for the developer to fill. The schema is in `server/src/eval/labels.ts`; it rejects unknown documents, same-document pairs, unknown labels, bad page:line, and any extra field such as a database ID.

**Tests:** 20 new or rewritten on top of stage 1.
- Pure: scoring (symmetry, contained-short-against-long, zero-weight words, the 2-term minimum, term order), query terms by mode, and ranking (split exchanges deduplicated from both directions with their best parts kept, direction independence, the same order for shuffled input, a loud failure on unknown parts).
- Database: split-exchange dedupe, top 5 counted by logical exchange with short exchanges findable, the GIN index's existence, CLI lookups (ambiguous name, `--case-id`, no match, deposition ownership, status and existence), and migration `0005` on a populated database.
- Labels: the label file and its schema.

All 233 tests pass on Node 24 with Postgres running; without it, 157 pass and 76 skip. Typecheck and `git diff --check` are clean.

**Codex re-review: one high-priority issue, fixed.** Discovery cut each query to its top 5 by `ts_rank_cd` *before* the final rule that a pair needs at least 2 shared weighted terms, so matches that would score 0 could fill the slots and push out valid ones. Reproduced first with a regression test, five high-`ts_rank_cd` targets sharing one weighted term and a lower-ranked sixth sharing two: the old code returned the five score-0 pairs and dropped the sixth.

The first version of the test didn't reproduce it. The "sixth" exchange had enough terms to run its own query and found the source from the other direction; Claude's comment in the test was wrong. The test now makes the sixth too short to query, and also checks that `ts_rank_cd` really ranks the five above it.

**Fix:**
- **In SQL:** the search's `WHERE` clause counts the query part's content terms that the target also has, excluding words every logical exchange in the case uses (weight 0, passed in from the frequency table). Fewer than 2 means the target is ineligible, so the top-5 cut only sees matches that will score above 0, with no over-fetch limit.
- **In `rankPairs()`:** drops any pair scoring 0, as a guard.
- **In `pairScore()`:** no longer rounds to 6 decimals, which could have turned a valid but tiny score into 0. It sums in sorted term order instead, so the score stays exact, symmetric and stable. The formula is unchanged.

**What the fix exposed in older tests:** five older database tests failed because their tiny made-up cases used the same few words in every exchange, which by definition gives those words no weight. Each test case now includes eight unrelated background exchanges from another witness, which count toward word frequencies but are never searched. The rare-terms test was redesigned: its target now shares two moderately common words, which `all_terms` finds and `rare_terms` doesn't.

**Results:**
- All 234 tests pass on Node 24 with Postgres running; without it, 157 pass and 77 skip. Typecheck and `git diff --check` are clean.
- On Ellison, three identical runs each: rare-terms 2,839 pairs in 0.6 s (was 3,193 including score-0 pairs, 0.3 s), all-terms 3,105 pairs in 2.2 s (was 1.3 s). No pair scores 0; the lowest is 0.025.
- Slots freed from score-0 matches let two very short exchanges reach the top with a score of 1.0 ("In the applications area? — Yes."; "to the customer, I mean? — Yes."), both wholly contained in their partner. That's the overlap coefficient's weak spot. The formula was left unchanged as instructed; the limit is recorded in `DESIGN.md` with a possible remedy (a minimum size for the smaller exchange), to be judged with labels.

**Codex final follow-up: two findings.**

1. **Short-exchange recall: tried, measured, rejected, documented.** Exchanges with exactly two content terms never query, so two of them that match can't find each other. A failing regression test reproduced it. A narrow fallback was then built: two-term exchanges whose two terms both carry weight may query, while the 3-term threshold stays for everything else.

   It worked as designed: 23 more queries, about 12 more pairs, runtime 0.60 → 0.64 s (rare-terms) and 2.2 → 2.5 s (all-terms), with one-term overlaps still excluded. But measured on Ellison, the new queries were mostly follow-up fragments that depend on the previous exchange ("Of your current products? — Yes.", "Let me try it again."). Each is wholly contained in some long answer, so it scores 1.0. Score-1.0 pairs in the top 20 went from 2 to 14, and the best real candidate (outsourcing) fell from rank 3 to rank 15.

   That fails the developer's "without significantly increasing retrieval noise" condition, so the fallback was reverted. The limitation is documented in `retrieve/procedural.ts` and `DESIGN.md`. The regression test now pins it: two two-term exchanges don't find each other, while a longer exchange still finds a two-term one. Two older tests had been re-aimed for the fallback and are restored. A real fix needs the scoring to discount tiny exchanges, which is out of scope here; the developer asked not to change the formula.

2. **Shared-term reporting: fixed.** `pairScore()` now reports only shared terms with positive weight, the ones that contribute to the score. Previously a word every exchange uses (for example *oracl*) could be listed. The score itself is unchanged, since such a term adds 0. A focused test reproduced the old listing first.

**Results:** all 236 tests pass on Node 24 with Postgres running; without it, 158 pass and 78 skip. Typecheck and `git diff --check` are clean. On Ellison after the revert: 700 queries, rare-terms 2,839 pairs in 0.66 s, all-terms 3,105 pairs in 2.56 s; the same counts as before, with the times within run-to-run variation.

**Status:** Path B stage 1 and all review fixes implemented and tested. Awaiting developer approval before commit. Path B tuning stops here; next is Path A and end-to-end analysis.

### October 28, 2026 — Path A: claims, retrieval and merge

**Branch:** `feature/path-a-claims`, from the committed Path B (`085a9b1`, not pushed).

**Goal:** Path A as approved: Haiku extracts the witness's factual claims, code verifies them against the stored lines, claims are paired across sessions by meaning, and both paths merge without losing exact evidence. No API call was made: the pipeline takes its model as a parameter, and the tests use a fake one.

**Developer decisions (approved):** entities stored as normalized text on each claim (no `entities` table); `time` as text; a `claim_tagging` table for coverage and resuming; CLI first, job wiring with analysis jobs; `merge.ts` pure, with the `candidates` table arriving with jobs. Added requirements:
- verify adopted questions with both the question and the explicit yes or no;
- signals are not contradictions;
- a non-overlapping predicate vocabulary;
- every attempt recorded, rejected claims kept with reasons, idempotent re-runs;
- a cost estimate and a 2-batch pilot before any full run;
- Path A independently measurable, with no recall claims before reviewed labels.

**What was built, by stage:**

1. **Schema (migration `0006`).**
   - `claims`: the model's reading kept apart from code's status, reason, match scores and evidence line IDs; the `llm_calls` row each claim came from.
   - A claim's part must be in its deposition, and the deposition the witness's.
   - A rejected claim citing a part outside its batch is kept, with the cited ID as text.
   - Claims are unique per model response.
   - `claim_tagging`: one row per part per extractor version.
   - Enums come from `claims/vocabulary.ts`: 16 predicates plus `other`, each with a written meaning. `recall_event` was drafted and removed before use, because it overlapped the epistemic status.
2. **Extraction.**
   - `claims/prompt.ts`: prompt, batch format, extractor version `claims-v1+claude-haiku-5-5`, and a pre-call estimate at 1 token per 3 characters with output at 40% of input, ignoring caching so it errs high.
   - `claims/model.ts`: the only API caller; low effort, structured output, cached system prompt.
   - `claims/verify.ts`: claim verification.
   - `claims/answers.ts`: `readAnswer`, the DESIGN.md Layer 2 reader, built here first because adopted questions need it.
   - `claims/tag.ts`: refusals and cut-offs recorded with their billed call; invalid output and errors marked failed; one transaction per batch.
3. **Retrieval.** `retrieve/pathA.ts`: one SQL query and a deterministic rollup to logical exchanges.
4. **Merge.** `retrieve/merge.ts`.
5. **CLI.** `scripts/patha.ts`.

**Bugs caught by tests before any real run:**
- The stored lines keep their turn markers ("A. Yes, they do."), so `readAnswer` read every plain answer as not plain. The marker is now stripped before reading.
- In review of the tests, Claude found its re-run logic would have deleted a rejected claim that cited a part from another batch once that part was tagged. Claims are now replaced by their actual part and unique per response; the uncommitted migration was regenerated.
- An operator-precedence slip (`a || b < 0`) would have put Path A pairs' sides in the wrong order.
- An ambiguous `status` column in Path A's SQL.
- Three test-fixture mistakes.

**Tests:** 32 new.
- Pure: `readAnswer`, claim verification and every rejection reason, entity normalization, prompt and estimate, merge, cap and budget.
- Database, with the fake model:
  - tagging stores every claim with code's verdict, marks parts and records the call;
  - refusal, cut-off, invalid output and a call that never answered;
  - re-runs that only retry what isn't tagged, with no duplicate claims;
  - a deposition that isn't ready.
- Path A: a paraphrase pair by meaning, all three signals in rank order, pairing by object, every exclusion, same-session, and the logical rollup.

All 268 tests pass on Node 24 with Postgres running; without it, 179 pass and 89 skip. Typecheck and `git diff --check` are clean. Migration `0006` applied to the development database.

**Estimate on Ellison (no API call):** P3171 has 534 parts in 45 batches, about $0.039. P3173 has 213 parts in 18 batches, about $0.015. A 2-batch pilot costs about $0.0015–0.0019 per deposition.

**Not done:** no API call (awaiting approval of the pilot), no commit. Path A coverage numbers and Path A-only pairs exist only after tagging.

**Status:** Implemented and tested. Awaiting approval to run the pilot, then review, then commit.

### October 28, 2026 — Path A pilot 1 and corrections

**Pilot 1 (approved, claims-v1).** The first `--pilot` would have taken each deposition's first 24 parts, mostly introductory, so a reproducible sample rule was added first: Path B shared-topic parts, plain yes/no answers, qualified answers, recollection answers, then long direct answers (`patha.ts sample`, and an `only` option on `tagClaims`, tested).

- **Run:** 48 parts in 4 calls, none failed or refused. 62 claims, **all 62 quote-verified**. That proves the quotes, not the interpretation.
- **Developer's semantic review (by Claude, reading every claim):**
  - polarity was right throughout;
  - 3 hedged statements were labelled asserted;
  - 4 claims took their meaning from another exchange;
  - "I don't know." answers produced no claim;
  - "oracle" was attached to 32 of 62 claims;
  - 16 were `other`;
  - the outsourcing statement "they're not buying any software" was missed.
- **Path A pairs between the samples:** 0.
- **Cost:** **$0.0077 actual against $0.0037 estimated**, above the ~$0.0034 approved. Output was 13,733 tokens against about 4,500 estimated, likely thinking (unconfirmed: thinking tokens weren't recorded yet). Cache: one 2,041-token write, three reads.

**Corrections (approved; no prompt or schema change was made without approval):**

1. **Qualifiers.**
   - The prompt (now `claims-v2`) defines hedges, and says "I'm sure" and "certainly" aren't.
   - Code records the hedge governing the key phrase. It looks only in the phrase's clause, up to the phrase's end, or at a bare disclaimer clause before it.
   - A first version reported "I believe" for 22, a hedge belonging to the next conjunct, instead of the governing "I don't know that for a fact". Claude caught it on real data and scoped the check to the phrase's end.
2. **Knowledge and recollection.**
   - `does_not_know` is added beside `does_not_recall`.
   - A plain "I don't know" or "I don't recall" answer becomes an adopted-question claim of the proposition as asked (`readRecollection`), with polarity required to be `affirms`. It is never a denial.
   - An adopted claim now needs a real question (`not_a_question` otherwise).
3. **Fragments.** A model flag `dependsOnEarlierExchange`, plus code rules: the exchange starts mid-turn, the question continues an earlier one, or the question or phrase is too short to stand alone. Context-dependent claims are kept and counted but never enter retrieval.
4. **Entity grounding.** A name is kept only if the exchange's words support it in full, or by a capitalized alias ("Ms. Catz"). Otherwise it is stored as ungrounded. A first version picked the longest word as "distinctive" and missed "Catz"; a test caught it.
5. **Object matching.** Exact equality is replaced by meaningful-word overlap: at least one shared content word, covering at least half the smaller object. Path A pairing now runs in a pure, tested `claimSignal`, with a new `knowledge_change` signal.
6. **The missed outsourcing claim.** Investigated without paid calls:
   - not the output limit (1,841 of 16,000 tokens);
   - not long-exchange handling (one unsplit 25-line part);
   - not batch composition (3 other claims were extracted from it).
   The likely cause is the prompt: the sentence is conditional ("*if* people outsource…, they're not buying any software"), and v1 defined hypothetical as a supposition with "if". It can't be confirmed, because raw output wasn't stored; every call now stores it. v2 says general statements phrased with "if" are asserted. A regression fixture (from 376's real lines) verifies the claim, finds it unhedged and self-contained, and shows Path A would now pair it with P3173 51:13 as `opposite_polarity`.
7. **Cost accounting.** `llm_calls` now records `thinking_tokens` and `raw_output`. The estimator uses the measured output share once 4 calls exist (1.01× now).

**Also added:**
- `reverifyClaims` / `patha.ts reverify`: re-applies code checks to stored claims for free.
- `--parts`: tags only listed parts, with an estimate first.
- `data/eval/claim-fixtures.json` (13 cases), checked by `patha.ts report`.

**Code-only corrections on the stored v1 claims (no API call):**
- 8 claims got a governing hedge. Model and code disagree on exactly the two claims found by hand (22, 376).
- 4 became context-dependent (533, 1551, 1591, and 1482 "It is integration software", a borderline exclusion).
- 24 had entities set aside, mostly an implied "oracle".
- 1 was rejected: 532, whose question breaks off with "--" and is finished in the next exchange.
- Fixtures: 8 of 13 pass on v1. The 5 failures need the v2 prompt: the missed outsourcing claim, the "everything listed" qualifier, "I don't know" for 140, the "it will make it a lot harder" fragment, and the "I'm sure" claim the model labelled qualified.

**Tests:** 291 pass on Node 24 with Postgres running; without it, 199 pass and 92 skip. Typecheck and `git diff --check` are clean. Migration `0007` applied to the development database.

**Pilot 2 (approved, claims-v2, 13 parts, 2 calls):**
- 13 parts tagged, none failed or refused. 19 claims: 18 verified, 1 rejected (1440 "Yeah, I think so.", `answer_not_plain_yes_or_no`, correctly).
- Cost **$0.0019 actual against $0.0033 estimated.** Cache: one 2,567-token write, one read. `thinking_tokens` were recorded as **0** on both calls, so output is the claims' JSON (about 150 tokens per claim), not thinking. The output share was 0.46× this time against 1.01× in pilot 1; it varies with claims per part. Total Path A spend so far: $0.0096.
- **Fixtures: 11 of 13 pass** (v1 on the same code: 8). Fixed by v2:
  - "I don't know" for 140 is now a `does_not_know` claim of the question as asked;
  - the "I'm sure" claim is now asserted;
  - the "it will make it a lot harder" fragment is now excluded;
  - 22 is now qualified by the model too.
- **New problem:** the model set `dependsOnEarlierExchange` on **14 of 19** claims, including self-contained ones. It flagged all four 376 claims, including the recovered outsourcing claim, and 22, 1417 and 1427, apparently treating the exchange's own question as earlier context. Context-dependent claims never enter retrieval, so the outsourcing claim, now extracted correctly (`buy` / denies / asserted, "if people outsource… they're not buying any software…"), is excluded. That fails its fixture and leaves Path A with 0 pairs.
- **Second failure:** the 1427 fixture expected a claim whose phrase includes "everything listed"; the model instead put the qualifier on the listed products claim ("we offer a product in database…", `sell`, qualified), which reads as correct. The fixture was likely too narrow; left unchanged pending the developer's decision.
- **Prompt fix confirmed:** the missed outsourcing claim is now extracted, which supports the diagnosis: the conditional "if" sentence was being skipped as hypothetical.

### October 29, 2026 — Path A: context flag as metadata, retrieval on the pilot claims

**Developer decisions:**
- Option A: the model's `dependsOnEarlierExchange` flag stays on each claim as diagnostic metadata, but alone never excludes a claim; only the deterministic rules do.
- The 1427 fixture stays unchanged.
- Qualified yes/no answers are documented as a known limitation.
- No vocabulary or scoring change, and no paid pilot.

**Change:** `contextReason()` no longer returns `model_says_depends_on_earlier_exchange`; a test pins that the flag alone excludes nothing. All 292 tests pass. Re-verifying the stored claims (no API call) changed only v2's context flags: 10 claims are no longer excluded.

**Retrieval and merge on the stored pilot claims** (no API call; Path A compares one extractor version at a time):
- **claims-v1 (pilot 1, 48 parts).**
  - Usable claims: P3171 31 of 40, P3173 9 of 22. P3173 lost 13 claims to predicate `other`, mostly definitions.
  - One Path A pair, `recollection_change` on `review`: P3171 204:20 "I don't think I've ever seen this specific presentation" (Exhibit 8's restructuring chart) against P3173 12:15 "I don't recall seeing the document" (Exhibit 550, a board M&A presentation).
  - **Different documents**, linked only because both objects contain "presentation". Likely irrelevant. Path B also had it, at rank 672.
- **claims-v2 (pilot 2, 13 parts).**
  - Usable claims: P3171 9 of 12, P3173 4 of 7.
  - One Path A pair: **the expected outsourcing pair**, `opposite_polarity` on `buy`. P3171 249:17 "…they're not buying any software" (denies) against P3173 51:13 "does the customer buy the software? — Yes, they do." (affirms). Linked by object overlap ("software" / "the software"). Merged rank 1; Path B found it too, at rank 3.
  - It is a retrieval signal, not a contradiction: P3171 describes the industry's outsourcing, P3173 Oracle's own service. That's for Sonnet to judge.
- **Path A only: 0 in both versions.** Both pairs were also found by Path B. With 48 and 13 parts tagged out of 747, this says nothing about Path A's added coverage.
- **Fixtures (v2):** 11 of 13 still pass. 1427 still fails (unchanged, debatable). The "it will make it a lot harder" fragment now fails, as expected under Option A: only the model flagged it, so it enters retrieval.

**Limitations that could prevent meaningful retrieval:**
1. Coverage: the pilots tagged 48 (v1) and 13 (v2) of 747 parts, and versions can't be mixed, so any real measure needs a full v2 run.
2. Object overlap on a generic head word ("presentation", "software") links different things, as in the v1 pair.
3. Predicate `other` (13 of P3173's v1 claims) never pairs.
4. Qualified yes/no answers are unrepresented.
5. Fragments only the model detects now enter retrieval.
6. The model flag over-flags; it is kept for diagnosis only.

**Status:** Change done and tested; no commit. Full extraction awaiting approval.

### October 29, 2026 — Path A full extraction (claims-v2) and retrieval report

**Approved:** a full v2 extraction of both Ellison depositions, run in order, with **$0.15 as the combined cap including retries**. Prompt, schema and retrieval rules unchanged. Before any call, the developer asked whether "not context-dependent" meant only the deterministic rules. Confirmed from the data: every excluded claim has a deterministic reason, and 10 claims carrying the model's flag were not excluded.

**Budget guard:** `patha.ts tag --all --budget <usd>` (CLI only, no library change) tags one batch at a time. Before each batch it stops if the run's actual spend plus the estimated cost of the remaining batches would exceed the budget. P3171 ran with $0.15. P3173 got the remainder ($0.0836).

**Extraction:**
- **Coverage:** P3171 527 parts (plus 7 from pilot 2) = **534 of 534**; P3173 207 + 6 = **213 of 213**. 0 failed, 0 refused.
- **Claims:** P3171 712 (616 verified, 2 approximate, 94 rejected); P3173 264 (236, 3, 25).
- **Rejections:** `answer_not_plain_yes_or_no` 82 (mostly qualified yes and no answers, the documented limitation), `not_a_question` 26, `plain_answer_not_asserted` 5, other reasons 7.
- **Predicates:** `other` 279 of 857 non-rejected claims (33%), `compete` 140, `support` 62, `measure` 62, then `plan`, `price`, `sell`, `role`, `know`, `review`, `buy`.
- **Polarity:** 735 affirms, 90 denies. **Epistemic:** 686 asserted, 133 qualified, 20 hypothetical, 6 reported, 8 does_not_know, 4 does_not_recall.
- **Context and model flag:** 78 claims context-dependent by the code rules; the model flag was set on 381.
- **Usable for Path A:** 381 claims in P3171, 135 in P3173.
- **Hedges and entities:** code found a hedge on 22 claims the model called asserted; 115 claims had entities set aside as ungrounded.

**Cost:**

| Run | Calls | Uncached input | Cache write | Cache read | Output | Thinking | Cost |
|---|---|---|---|---|---|---|---|
| P3171 | 44 | 56,774 | 2,567 | 110,381 | 118,446 | 11,749 | $0.0663 |
| P3173 | 18 | 21,543 | 0 | 46,206 | 45,987 | 7,709 | $0.0256 |

- **Total $0.0919** against the $0.108 estimate and the $0.15 cap.
- All of Path A so far, pilots included: **$0.1015**.
- Thinking is about 10% (P3171) to 17% (P3173) of output; the rest is the claims' JSON.

**Retrieval (P3173 against P3171):**
- **Path A:** 175 pairs in 37 ms.
  - Signals: 33 `opposite_polarity`, 142 `different_value`, 0 recollection or knowledge changes (only 12 no-knowledge or no-recall claims exist).
  - Links: 157 by a shared entity, 18 by object overlap only.
- **Path B:** 2,839 pairs (`rare_terms`), 3,105 (`all_terms`).
- **Overlap with `rare_terms`:** 27 pairs found by both paths, **148 only by Path A**, 2,812 only by Path B. The shared pairs' median Path B rank is 1,141; 7 fall within B's top 300.
- **Overlap with `all_terms`:** 41 both, 134 Path A only.
- **After merging (300-pair budget, cap 3 per exchange):** 53 Path A pairs would be adjudicated, 40 of them found only by Path A (17 `opposite_polarity`, 36 `different_value`).

**Quality (Claude reading the top 20 merged pairs and 40 Path A-only pairs):**
- **Useful:**
  - #1, the outsourcing pair, found by both paths;
  - #2, "I saw them enter the database market and become very competitive" against "could they monopolize enterprise application sales? — No";
  - #3, "our sales force would not be selling both the e-business suite and PeopleSoft" against "the e-business suite requires customers to get the bulk of their applications from Oracle";
  - "virtually all of the dot com companies used Oracle applications" against "not everyone is going to buy only Oracle application software".
  All are related statements worth adjudicating, most likely compatible.
- **False positives, by type:**
  - **Hubs.** Six P3173 claims each pair 10–21 times: "Largely a function of scale" (21), the bare list "IBM, Microsoft, Sun, BEA, SAP" (21), "compete better with Microsoft? — Absolutely" (18), "could they monopolize…? — No" (13).
  - **Ubiquitous entities as links.** Microsoft links 81 pairs, SAP 26, Oracle 25, PeopleSoft 25.
  - **`different_value` from disjoint objects.** Same predicate and company, but objects that describe different aspects, such as "free database" against "the entire technology stack". This is the largest noise source.
  - **Unrelated propositions sharing a polarity flip.** "We wouldn't be advertising PeopleSoft products" against "the intent is to get our applications 100 percent to Java".
  - **A context fragment.** "does Oracle supply that type of software? — No" pairs with every "Oracle sells…" claim; "that type" refers to an earlier exchange, and only the model flagged it.

**Limitations (no change made):**
- Common-entity and generic-object links, and hub claims, dominate Path A.
- `different_value` on disjoint objects is mostly noise.
- `other` takes a third of the claims.
- Qualified yes and no answers make up most rejections.
- Context fragments flagged only by the model enter retrieval.
- No recall claim is possible without independently reviewed labels.

**Status:** Awaiting developer review; no commit.

### October 29, 2026 — Evidence review before adjudication (no API call, no retrieval change)

**Counts reconciled (claims-v2, 976 claims).**
- Exclusive buckets: rejected 119; context-dependent by a code rule 63 (excluding the rejected); hypothetical or reported 24; predicate `other` 254; **usable 516** (P3171 381, P3173 135).
- In total, 78 claims are context-dependent: 63 kept plus 15 that were also rejected.
- The earlier distributions used the **857 non-rejected claims** (852 verified + 5 approximate) as denominator, so "`other` 279" includes context-dependent and hypothetical claims that the waterfall counts first.
- **Correction:** the earlier report said 735 affirms; the right figure is **767** (735 was asserted and qualified only). Denies is 90; epistemic totals 857 as reported.

**Context dependence.** 78 claims excluded:
- 51 for a phrase too short to stand alone: "Sure.", "Occasionally", "Indefinitely", "More customers";
- 14 for a question too short: "And No. 4?", "In the applications area?";
- 8 for starting mid-turn;
- 5 for a question continuing an earlier one.

Mostly real fragments; some borderline ("we wouldn't approve it", some mid-turn parts). The model's flag has no effect: **188 claims carry it and remain eligible**, `contextReason()` doesn't read it, and Path A's SQL filters only on `context_dependent`.

**Evaluation sample (`scripts/eval-sample.ts`, reproducible: three runs gave identical files).**
- **Pairs:** 60 = 20 Path A only (of 148), 20 Path B only (of 2,812, `rare_terms`), 20 found by both (of 27). Each group is split into high / medium / low thirds of its own ranking and sampled evenly (7 / 7 / 6).
- **Source exchanges:** 20 P3173 exchanges, evenly spaced, with every pair retrieved for them (2 have none). Reviewers look for related P3171 testimony that neither path found; recall is measured from these, never from retrieved pairs.
- **Files:** `data/eval/retrieval-sample-v1.json` holds references, ranks, signals and empty evaluation fields (attribution, same proposition, potential contradiction, compatible, insufficient context, worth lawyer review, note). `data/eval/review/*.csv` adds the testimony and is git-ignored, since it is regenerable.

**Review of migration 0007:**
- **Correct on populated data.** It only adds columns with defaults or nulls and a check that existing rows pass, and it applied cleanly to the development database.
- **One hazard:** Drizzle applies all pending migrations in one transaction, and Postgres can't use a new enum value in the transaction that added it. A future migration that uses `'does_not_know'` (a check or default naming it), applied together with 0007 on a fresh database, would fail. Mitigation: cast to text in such checks, as 0002 does, or apply it on its own.
- **Not covered by a populated-database migration test** (0001 and 0005 are).

**Review of the CLI budget guard:**
- **Resumable and idempotent per part.** A re-run tags only parts not yet tagged, retrying failed and refused ones.
- **Estimate-based, not worst-case.** `DESIGN.md`'s guard checks each call's *maximum* cost against what remains. This one checks the run's spend plus the *estimated* remaining cost, so the last batch can overshoot by its own estimation error. That is small here: the worst case for one Haiku call at 16,000 output tokens is about $0.0086.
- **The budget isn't persisted.** The combined cap across runs relied on passing the remainder by hand. A crash after a call is recorded but before its result is stored leaves a billed call the next run doesn't count, and two concurrent runs would each spend their own budget.
- **It lives only in the CLI,** not in `costs/` (`assertBudget` in `DESIGN.md`), so a worker path wouldn't have it.
- Retries of failed and refused parts by a later run are inside that run's budget only.

**Status:** Sample, findings and adjudication proposal awaiting review; no commit.

### October 29, 2026 — Budget enforcement and the minimal adjudication path (no paid call)

**A. Budgets (`costs/budget.ts`, migration 0008).**
- Budgets and reservations are stored in Postgres.
- Before a call, its worst case (input bounded by characters at the cache-write rate, output at `max_tokens`) is reserved in one conditional `UPDATE`, so concurrent workers can't overspend: in a test, 20 concurrent reserves left exactly 10 that fit.
- **Settle** charges the recorded cost; an unpriced call is charged the full reservation.
- **A 4xx is released** (it wasn't billed). Timeouts, 5xx and connection loss are marked **uncertain** and charged in full.
- **Reservations left open by a crash** are reconciled as uncertain.
- SDK retries are off for both models, so every attempt reserves its own cost.
- **Path A** `tagClaims` takes a `budgetId`. `patha.ts tag --all` now spends from a named stored budget, replacing the estimate-based guard. `BudgetExceeded` stops the run before the call and leaves the parts untagged.

**B. Adjudication.**
- **Modules:**
  - `adjudicate/`: packet, prompt `adjudicate-v1`, Sonnet client, `assess()`, `adjudicateCandidate()`;
  - `verify/`: v1's `verify.ts` moved to `verify/quotes.ts` unchanged, plus `answers.ts`, shared text helpers, Layer 1 and Layer 2;
  - `score/`: `RUBRIC_V1`, checks, `score()`, `prioritize()`.
- **Stored:**
  - verdicts as received, with status, raw text and the packet's line IDs;
  - findings with evidence status, attribution levels, factors, caps, checks, rubric version and priority;
  - calls with effort and latency.
- **Two problems found while building:**
  - v1's word-share match accepts a phrase whose negation was dropped or added (0.675 and 0.9). Layer 1 now requires approximate matches to carry the same negations as the best-matching sentence.
  - The excerpted P3171 omits page ranges, so "5 lines before" could show text from 19 pages earlier. Context now stops at a page skip, and the packet says pages are omitted.

**C. CLI:** `scripts/adjudicate.ts persist|list|show|estimate|run`.
- Set `ellison-v1` holds 300 selected and 2,687 deferred candidates, the same counts as before (175 Path A + 2,839 Path B − 27 found by both).

**D. Six pairs for labelling (labels left to the developer):**

| # | P3171 | P3173 |
| --- | --- | --- |
| 1 | 249:13 | 51:13 |
| 2 | 146:18 | 163:10 |
| 4 | 37:1 | 216:22 |
| 17 | 43:5 | 79:9 |
| 49 | 152:15 | 130:12 |
| 105 | 143:17 | 153:13 |

Most top-ranked `opposite_polarity` pairs read as retrieval noise. Hub answers such as 23:11 "No, we don't." and 163:10 "No." are linked to many unrelated exchanges.

**E. Tests:**
- the 16 DESIGN scoring cases with exact component values, the cap matrix, the strict schema and the properties;
- Layer 1 and 2 cases;
- adjudication end to end with a fake model;
- Path A under a budget.

**Results:** 383 tests pass and typecheck is clean.

**Estimate for the six:** worst case $0.61 in total ($0.10 each, almost all of it the 8,000-token output bound); typical about $0.12.

**Status:** Awaiting review; no paid call, no commit.

### October 29, 2026 — Adjudication pilot 1 (6 calls, approved)

**Run:** Sonnet 5.5, effort medium, `adjudicate-v1`, rubric v1, budget `ellison-adj-pilot1` ($0.30). Candidates 1, 2, 4, 17, 49 and 105, run one at a time.
- **Calls:** 6 valid verdicts, no failures, every reservation settled.
- **Cost:** **$0.0461** total; 32 s elapsed.
- **Evidence:** every key phrase verified exactly.
- **Classifications:** all `false_positive` (4 `different_event`, 2 `both_can_be_true`).
- **Scores and priorities:** scores 60 to 80; priorities 3 `needs_context`, 3 `low`.

**Usage:**
- 705 to 1,386 uncached input tokens per call;
- the system prompt (2,738 tokens) was written to the cache once, then read from it;
- 378 to 486 output tokens;
- **0 thinking tokens on every call**;
- latency 3.5 to 6.2 s.
- The typical estimate ($0.12) was 2.6x the actual cost.

**Observations for review (nothing changed):**
- **Bare answers as key phrases.** Claude used "Yes, they do." and "Yes." as key phrases (#1, #4), against the prompt's instruction to use the question's words. They verify exactly and read as the witness's own answer, but they carry no proposition.
- **The alternative-explanation deduction hit every call.** Sonnet always gave an alternative explanation, so every call lost 10 points.
- **Context requests.** `needsMoreContext` put 3 of the 6 false positives in the `needs_context` priority.
- **A page gap cost context points.** #105's B side sits after a page gap, so it has no context lines, and code's context check gave 0 of 5.
- **Path A disagreed on attribution** for #49 and #105 (-5 each).

This is a test of rejecting false positives and of the pipeline, not of recall.

**Status:** Awaiting review; no commit.

### October 29, 2026 — Short-answer evidence, pilot issues, synthetic evaluation, performance (no paid call)

**1. Short-answer evidence (correctness bug, fixed).**
- **The bug.** Pilot calls #1 and #4 used "Yes, they do." / "Yes." as key phrases. Layer 1 found them in the answer and treated them as the witness's own clear statement, with no proposition attached.
- **Bare answers.** A key phrase made only of answer words (yes, no, sir, correct, I don't recall…) now stands for its question. The question and answer are read together with `readAnswer`. The question becomes the side's proposition for code's checks (corroboration, time, Path A disagreement). The evidence lines are the Q and A lines.
- **Bare answer with no question:** unsupported.
- **Compound questions.** When the key phrase cites only part of the question, a plain No to "A and B?" and a plain Yes to "A or B?" are uncertain.
- **A related bug** (fixed): the v1 matcher accepted a fabrication assembled from different sentences ("I met Daniel Cho at the warehouse", 0.675). An approximate match now has to be found within one sentence.
- **Re-assessing the six stored pilot verdicts** (read-only): the scores are unchanged; #1 and #4 now show their Q and A lines.

**2. Pilot issues: review and proposals (rubric unchanged).**

*Correctness bugs, fixed:*
- bare answers;
- evidence lines without the answer;
- fabrications assembled across sentences;
- the context label at a page gap, which now names the source gap.

*Correctness issues, not fixed: they need approval because Path A shares the code, or because they change how the rubric is applied:*
- **(a) `readAnswer` misses some plain answers.** It doesn't read "No, never." as a plain No (Hargrove case). It is shared with Path A's claim checks.
- **(b) `findHedge` misses some hedges.** "might have", "maybe" and "may have" aren't hedges (Alone case). It is also shared with Path A.
- **(c) The false-positive attribution points are too strict.** Code counts any different reading as contradicting Claude, even when code's reading is indefinite: a mixed answer (`question_other`), or a witness's answer where nothing was found. That cost 8 points in the Pizza and Hargrove cases. Proposal: code contradicts Claude only when Claude claims a higher level than a definite code reading, or the stances conflict.
- **(d) Pronouns count as shared terms.** The negation-asymmetry check counts "him" as a shared content term, because v1's stopword list is small. Proposal: a scoring-only stopword list in `score/checks.ts`.
- **(e) The typical cost estimate is too high.** It assumes 1,500 output tokens; the measured average is about 430. Proposal: switch to measured values, as DESIGN says to do after the first run.

*Scoring-design choices, each with a proposal:*
- **Alternative-explanation deduction.** It is working as specified, but Sonnet gave an alternative on 6 of 6 calls.
  - Proposal A (recommended first): prompt `adjudicate-v2`. `alternativeExplanation` must be null unless specific lines support a contrary reading, cited by page:line. The rubric is untouched.
  - Proposal B: rubric v2, with a categorical `alternativeStrength` (none, weak or strong) and the 10-point deduction only for strong.
- **False positives entering `needs_context`.** DESIGN's priority table sends any verdict with `needsMoreContext` to `needs_context`, so harmless pairs crowd the lawyer's "needs context" queue (3 of 6). Proposal: for false positives, keep the score-based priority and show a "context requested" marker. Reserve `needs_context` for direct, inferential and insufficient-evidence verdicts.
- **Source page gaps.** The packet already stops at the gap and says so, and the label now names the source gap. Code's 5 context points stay withheld, because the model genuinely saw no context. Proposal: no rubric change.
- **High support scores on false positives.** "80 High" on a false positive is support for "not a contradiction", but it reads like a strong contradiction. Proposal (UI only):
  - show false positives in their own "likely not contradictions" section;
  - label the score "Support for 'not a contradiction': 80/100", in a neutral colour;
  - sort them below conflicts.

**3. Synthetic evaluation.**
- **What it is.** `eval/synthetic.ts` builds 6 labelled cases from v1's Marcus Webb transcripts:
  - direct (Cho);
  - conflicting times (bedtime);
  - qualified direct (home all evening, then "I think I went out");
  - recollection change (pizza);
  - qualified but compatible (alone, then a neighbor "might have seen me");
  - compatible (warehouse, then the area).
- **Storage.** `eval/syntheticStore.ts` ingests both sessions through the real ingestion code and stores one candidate per case. In the dev DB this is set `webb-synthetic-v1`, candidates #2988–2993, created by `scripts/adjudicate.ts fixtures`.
- **Results with a fake model** (`tests/db/synthetic.test.ts`). Every correct verdict verifies. The scores are 90, 75, 66, 77, 75 and 77, each recomputed by hand. Faulty verdicts are also caught: a fabricated quote is unsupported, a near-fabrication is a wrong reference, and a direct call resting on no recall is capped at 40.
- **Paid-run estimate:** at most $0.59; about $0.04 expected from the measured rates.

**4. Performance (from the six measured calls; no concurrency built).**
- **Packets:** the 294 still-selected packets average 2,460 characters (90th percentile 3,704). The pilot packets measured about 2.7 characters per token.
- **Cost per call:** about $0.0064 with a warm cache (90th percentile about $0.0080), plus $0.007 once per cold cache.
- **Latency:** 3.5 to 6.2 s, mean 4.8 s.
- See the report for the 30, 100 and 300 figures.

**Tests:** 405 pass and typecheck is clean.

**Status:** Awaiting review; no paid call, no commit.

### October 29, 2026 — Synthetic adjudication run (6 calls, approved) and correctness fixes

**Run.**
- Sonnet 5.5, effort medium, `adjudicate-v1`, rubric v1, budget `webb-synthetic-pilot1` ($0.20), run one at a time.
- 6 valid verdicts; every citation verified; **$0.0433**; 26 s. Uncached input 529–740 tokens, output 424–476, thinking 0, latency 3.3–4.8 s.

**Result: Sonnet called all six false positives.** Labels are unchanged, and agreement is 3 of 6:
- **Agreed:** pizza, alone, Hargrove (all labelled false positive).
- **Missed (labelled direct):**
  - Cho: `value_conflict`, but classified `both_can_be_true`;
  - bedtime: `qualified_statement`;
  - home: `qualified_statement`.
- **Its own fields show it saw the conflicts.** Its explanations call them "a real tension", "notable" and "in tension". For Cho it gave `conflictBasis: value_conflict` together with `false_positive`.
- **Likely cause: the prompt.** `adjudicate-v1` lists "a qualified or unrecalled statement" among false-positive examples. DESIGN instead scores a qualified conflict as direct or inferential capped at 70 (case 7).
- **Context requests and alternatives:** all six had `needsMoreContext`, and all six gave an alternative explanation.

**Fixes made after the run (approved):**
- **(a) `readAnswer`:** explicit denials and affirmatives, including elaboration that keeps the same direction.
- **(b) Hedges:** possibility and recollection hedges, but not when quoted, negated or reported from someone else.
- **(c) Bounded Layer 2:** exact, upper or no code reading; overstatement and understatement both recorded.
- **(e) Cost estimate:** from measured calls only, with the worst case at `max_tokens`.
- **Priority routing:** false positives with a context request keep their score-based priority, and `findings.context_requested` is added (migration 0009, backfilled from verdicts).
- **Fake-model scores after these fixes:** 90, 67, 66, 85, 80, 85.

**(d) Pronouns, investigated.**
- Pronoun-only overlap occurred once (Cho, "him"), and there it named the same person, a legitimate signal. A pronoun stopword list isn't recommended.
- Found instead: "No. 1" is read as a negation (#105). Proposed narrow fix: ignore "No." followed by a number.

**Tests:** 422 pass and typecheck is clean.

**Status:** Awaiting review; no commit.

### October 29, 2026 — adjudicate-v2 experiment (6 calls, approved)

**What was built.**
- **Prompt `adjudicate-v2`, a new version beside v1** (v1 stays the default):
  - a qualified statement can still contradict;
  - no invented explanations to dismiss a conflict;
  - a hypothetical reconciliation becomes a marked alternative explanation;
  - different events are still a false positive;
  - `conflictBasis` is `none` for false positives;
  - `needsMoreContext` only when specific missing lines would change the answer.
- **Schema `VerdictV2`** adds `alternativeSupport` (established, plausible or speculative).
- **Consistency check** (`adjudicate/consistency.ts`, categorical fields only). Inconsistent verdicts are kept with `verdicts.consistency_issues` (migration 0010); their finding is unscored (`inconsistent_verdict`) and goes to `needs_context`.
- **Verdicts are kept per prompt version.**

**Run.**
- Budget `webb-synthetic-v2` ($0.20), run one at a time: **$0.0490**, 31 s.
- 6 valid verdicts, 0 consistency issues, every citation verified, thinking 0, latency 3.5–7.5 s.
- The v2 system prompt is 3,511 tokens (v1: 2,738).

**v1 → v2, against the labels:**

| Case | Label | v1 | v2 |
| --- | --- | --- | --- |
| Cho | direct | false positive (inconsistent: `value_conflict`) | **inferential**, 60 Medium. A conflict was found, but not the labelled subtype; it names the timing assumption. |
| Bedtime | direct | false positive (inconsistent) | **direct** ✓, 67 Medium, both sides qualified |
| Home | direct | false positive | **direct** ✓, 66 Medium, side B qualified |
| Pizza | false positive | false positive ✓ | false positive ✓, 80 High, low priority |
| Alone | false positive | false positive ✓ (inconsistent fields) | **direct ✗, a regression**, 70 Medium. It relied on context lines outside the cited exchanges (10:02 "home all evening", 40:03 groceries). |
| Hargrove | false positive | false positive ✓ (inconsistent fields) | false positive ✓, 75 High, low priority |

**Exact agreement:** v1 3/6, v2 4/6. Under v2, every conflict was flagged as a conflict (3/3), and 2/3 compatible cases were kept.

**Other observations:**
- `alternativeSupport` was "plausible" on 6 of 6 calls, so it doesn't yet discriminate.
- Of the 6 stored v1 synthetic verdicts, the consistency check would flag 4. It flags none of the Ellison pilot verdicts.

**Tests:** 432 pass and typecheck is clean.

**Status:** Awaiting review; no commit.

### October 30, 2026 — Overnight sprint: stabilize, workflow, review app (no paid calls)

The detailed log is `docs/overnight-progress.md`.

**Phase 1 (stabilize):**
- **Inference chain rule:** the steps together must cite both exchanges, and each step must cite only valid IDs. A step with an invalid ID gates scoring.
- **Page-break bug:** the fixture was malformed (25 lines on a 22-line layout). Synthetic storage now runs the real `validateDeposition`, with regression tests.
- **v3:** completed, with v1 and v2 prompts pinned by hash.
- **Client build:** `client/tsconfig.json` restored to the Vite project references.

**Phase 2 (backend workflow):**
- migration 0011 (`analyses`, `verdicts.origin`/`replay_of`, `depositions.original_filename`);
- analysis job with demo replay and live mode under the budget;
- the gate on `ALLOW_PAID_CALLS`;
- case, analysis and finding endpoints;
- tests, including a real two-PDF end to end.

**Phase 3 (review app):** Tailwind; cases, case and analysis pages; side-by-side evidence view; plain-language labels; demo labelling.

**Phases 4 and 5:**
- performance measured;
- demo script;
- docs;
- 470 tests pass and typecheck is clean;
- client build passes;
- one intermittent failure in `worker.test.ts`, recorded.

**Status:** No commit, no paid calls.

## October 30: whole-product benchmark (no paid calls)

**Goal:** measure the real product on the two Ellison PDFs, and prepare a paid benchmark for approval.

**Added:**
- `server/src/timing.ts`, optional stage timings around upload, ingestion, retrieval and adjudication; off unless `BENCHMARK_TIMING_FILE` is set;
- `scripts/benchmark.ts` and `scripts/benchmark-browser.ts`, resumable runs with a real headless Chrome and no new dependency;
- Haiku calls now record latency;
- replay now finds stored verdicts by file hash, parser version and exchange group, so the same PDFs in a new case replay, with their exchange IDs changed to the new ones (one new test).

**Measured:** two runs. Both files stored in about 4 s, analysis complete 3.8 to 4.7 s after the click, 0 model calls.

**Found:**
- a fresh upload has no claims, so the run was Path B only;
- only 4 of 300 selected pairs have a stored verdict;
- the progress panel shows "Both transcripts are read" while queued.

**Status:** 471 tests pass; typecheck and client build pass. No commit, no paid calls. The live benchmark awaits approval.

## October 30: adjudication strategies (no paid calls)

**Goal:** reduce a 300-pair analysis from about 17 minutes without losing accuracy.

**Added:**
- a bounded worker pool, strategies A to F and control P, and `adjudicate-batch-v1`, built from v3's text;
- `adjudication_requests` (migration 0012), recording every request once;
- cancel, shutdown and restart handling: a live analysis found mid-run is marked interrupted, and only an explicit resume continues it;
- response checks for missing, duplicate, unknown and cross-candidate verdicts.

**Closed out analysis 9:** interrupted, with its open reservation counted in full. Dates corrected on depositions 24 and 26.

**Found:** batching should save only about 8%, and little time, because output dominates both. Concurrency should do the work. This is unmeasured until the live run.

**Status:** no commit, no paid calls. Strategy A stays the default.

## October 30: live strategy comparison (approved, $3.00 limit)

Ran B, D and C on the 40-pair sample; spent $0.7287.

- **C (10 at once):** 20.3 s, 7 of 7 contradictions found, 2 of 9 compatible pairs flagged.
- **B (5 at once):** 39.6 s, the same classification on all 40 pairs.
- **D (batches of 10):** 45.3 s, 5 of 7 found, 7 pairs with no verdict, 3 "placeholder" explanations.

**Fixed:** `readBatch` now rejects unreasoned explanations; the experiment report handles candidates with no verdict, and `report` writes results from stored rows.

**Status:** recommendation is C with v3. The app defaults are unchanged. No commit.

## October 30: strategy C promoted (approved)

New analyses default to strategy C (10 independent single-pair requests) with `adjudicate-v3`. A remains the sequential fallback, and `maxConcurrency` is configurable. Batch strategies are refused by the API and absent from the UI and worker; they remain for `scripts/adjudication-experiment.ts`. Demo replay no longer uses batch verdicts. Mode still defaults to demo, and paid calls still need `ALLOW_PAID_CALLS=true`.

Added `benchmark.ts preflight` and full-run measures. No paid calls, no commit.

## October 30: full Ellison benchmark (approved, $3.00 limit)

Analysis 11: 300 of 300 pairs, strategy C, `adjudicate-v3`, Path A + B with reused claims. 109.7 s, $1.8867, peak 10, no rate limits or failures, no retries. Sonnet found 0 direct or inferential pairs (288 false positive, 12 insufficient evidence), and only 4 pairs were judged the same event, which points at retrieval precision. 297 of 300 citations verified. Inspection in the benchmark folder. No commit.

## October 30: Milestone 2, hybrid retrieval (no paid calls, no commit)

Built statement-card extraction, the topic map, Path A from cards, the union with 60/40 allocation, the hybrid analysis option, discovery evaluation and `docs/api-contract-v1.md`. All mock models.

What the agent got wrong, and what caught it:

- Milestone 1's `CARDS_JSON_SCHEMA` carried `minLength`, which structured outputs reject and `messages.create` doesn't strip. The first paid call would have failed. Found by checking the API docs before relying on it.
- The first discovery run scored badly and much of that was the test: distractors contradicted each other (one subject, several months). A later unit test caught a second case of the same bug (subjects repeat every 36, not 108). A distractor has to be a fair negative.
- Ranking treated "shared person, different date" as a strong signal across unrelated events. Now a signal needs the same event, which is what DESIGN.md says a contradiction needs.
- Capacity 300 selected only 176 pairs while 495 sat behind the per-exchange cap. Spare capacity now reaches them.

The discovery numbers are development numbers: `topic-rank` changed after seeing results on these suites, so they can't be claimed as held-out recall.

## October 30: statement-card pilot (approved, $0.10 limit)

Four chunks of `cards-v1` with Haiku, two from each Ellison session (depositions 1 and 2, budget `cards-pilot-1`). Cost $0.01576768: 11,525 input, 2,256 cache-write, 6,768 cache-read and 28,531 output tokens. No retry, split, truncation or refusal; largest output 8,368 of 16,000 tokens. No topic map or Sonnet call.

143 cards returned, 141 accepted (98.6% source-grounded), 2 rejected as `source_phrase_not_in_exchange`: one changed a word, one stitched question and answer together. 97 unique exchanges: 94 carded, 3 `no_assertion`, 0 omitted, 0 failed. Migration 0014 was applied to the development database first.

Before the run, two gaps were closed: `--max-chunks` didn't cap calls (a cut-off chunk could split), and `cards` didn't check the deposition belonged to the witness.

Grounding proves the words exist, not that the card reads them correctly. Reading the cards found what the rate can't see:

- 14 of 141 statements are negative, against the positive-form rule; two are `denies` on a negative statement, a double negative.
- The overlap dedupe never fired: 8 redundant cards on 7 overlap exchanges were reworded, so the normalized statements differ.
- 45 of 141 cards use predicate `other`, which weakens the entity link.
- 15 cards in P3173 have the exhibit's title as their event line, too coarse for topics or for `comparable`.
- 1 card came from an exchange with no witness answer.

The 141 `cards-v1` cards stay stored; `cards-v2` doesn't reuse them.

## October 30: pilot fixes (approved, no API calls)

`cards-v2` adds the prompt rules above. `readCards` now rejects `no_witness_answer` and `negated_denial`, counts other negated statements, and keeps the first chunk's cards on an overlap whatever the wording. `topic-rank-v2` stops predicate `other` from making entity links.

## October 30: `cards-v2` check (approved, $0.10 limit)

The same four chunks with `cards-v2` (budget `cards-pilot-2`). Cost $0.01361878: 11,525 input, 2,405 cache-write, 7,215 cache-read and 24,187 output tokens. No retry, split, truncation or refusal.

131 cards returned: 123 usable, 5 `duplicate_card`, 1 `negated_denial`, 2 `source_phrase_not_in_exchange` (97.6% source-grounded). 97 unique exchanges: 84 carded, 8 `no_assertion`, 4 omitted, 1 failed. Against `cards-v1`: negated statements 15 to 4, the most repeated event line 15 cards to 6, distinct event lines 58 to 78, predicate `other` 32% to 28%, and the no-answer card is gone.

New: 4 omissions, all short document-handling exchanges, one malformed ID in `noAssertion` (`E41X`, counted and ignored), and a card attached to the wrong exchange (rejected). The 11 exchanges carded by v1 but not v2 are mostly procedural; two are borderline (E13, E31). The check is one sample of 97 exchanges.

## October 30: full `cards-v2` extraction (approved, $0.50 limit)

27 calls, budget `cards-full-1`, $0.09550475: 76,324 input, 64,935 cache-read and 174,446 output tokens. No split, truncation, refusal or failed call; largest output 13,593 of 16,000 tokens. It also re-sent the 5 parts the check left omitted or failed.

747 exchanges: 568 carded, 85 `no_assertion`, 78 omitted (10.4%), 16 failed. 856 usable cards; rejected: 25 `negated_denial`, 14 `source_phrase_not_in_exchange`, 3 `invalid_fields`; 87 `duplicate_card`. 95.3% source-grounded. 80 usable statements are still negated (9.3%). Path A has 252 pairs with no topic map (28 also found by Path B); 22 excluded.

The check's reading of omissions was wrong. They are not scattered procedural exchanges: most sit in a few calls that ended normally having returned far too little, including long testimony on Microsoft, SAP and scale. A completed call isn't a complete chunk.

## October 30: thin-chunk check and retry (approved, $0.10 limit)

Added `thinChunks`: a readable response that addressed under half its parts is reported with its call. The retry (budget `cards-retry-1`) cost $0.02746513 over 9 calls: 17,076 input, 2,405 cache-write, 19,240 cache-read and 50,529 output tokens. One chunk was truncated at 16,000 tokens and split automatically, which is why 7 planned chunks became 9 calls.

747 exchanges now: 625 carded, 117 `no_assertion`, 0 omitted, 5 failed. 967 usable cards, 94.9% source-grounded, 87 negated (9.0%). All card work so far: 44 calls, $0.15235634.

The check has a gap. Call 621 listed substantive testimony in `noAssertion` (19 exchanges, 11 with answers over 40 characters), mostly PeopleSoft pricing after the merger. `noAssertion` counts as addressed and a re-run skips it, so neither the check nor a retry can catch it. Across the deposition, 16 `no_assertion` exchanges have answers over 40 characters. Not fixed yet.

## October 30: noAssertion treated as an extraction result (approved, $0.05 limit)

Path B was verified independent of card state. One model-driven gap was closed: card labels used to mark a pair `excluded`; such pairs now rank last and defer with that reason, still eligible. Added `suspected_omission` (migration 0015), screening on answer size, factual language and short answers to factual questions, and targeted re-extraction with two exchanges of context. A repeated `noAssertion` stays suspected.

Call 621, the source of most false `noAssertion`s, was itself a retry of scattered leftovers with no context, so the earlier retry likely caused the problem it was meant to fix.

The screen flagged 35 of 117 `no_assertion` results. Targeted extraction of the 15 long ones (budget `cards-suspect-1`, one call, $0.00447312) recovered 16 usable cards on 12 exchanges, with no rejection. E61, E97 and E222 stay suspected. 747 exchanges now: 637 carded, 82 `no_assertion`, 23 `suspected_omission`, 5 failed, 0 omitted. All card work: 45 calls, $0.15682946. Known screen misses: E1578 and E1388, short answers adopting a fact, are still `no_assertion`.

## October 30: short-answer screen and final targeted retry (approved, inside the $0.05 limit)

The screen no longer lets housekeeping wording hide a fact, and flags short substantive answers and answers whose question is in an earlier part. 62 exchanges were flagged; 59 were sent with context (E61, E97 and E222 had already had their retry). 6 calls, $0.00651888: 11 exchanges recovered, 12 usable cards, 11 rejected. 747 exchanges now: 648 carded, 43 `no_assertion`, 51 `suspected_omission`, 5 failed, 0 omitted. 995 usable cards. All card work: 51 calls, $0.16334834.

Grounding did its job: most rejections were the model attaching phrases from other exchanges in the batch to E149 and E151. `thinChunks` fires on every targeted call, since a repeated noAssertion is not counted as addressed, so it means little there. Answers relying on an earlier question (E162, E223, E365, E369, E392) are still `no_assertion`: reading them needs context the screen doesn't have.

## October 30: first topic map (approved, $0.10 limit)

One Haiku call, budget `topics-map-1`, $0.00712828: 17,539 input, 747 cache-write and 10,562 output tokens, no truncation. Map version 1: 49 topics over 995 cards, 961 assigned (96.6%), 34 unassigned, 7 unknown IDs rejected, 16 duplicates dropped. No near-duplicate names; largest topic 6.1%.

38 of the 49 topics cover one session, and only 15 cards have a secondary topic.

## October 30: first live hybrid analysis (approved, $3.00 limit)

Hybrid per-exchange cap raised to 5; the pair pool keeps 3. A `useStoredCards` option made the run use the stored cards and map, with no Haiku call. Analysis 12: 300 of 300 pairs, 180 Path A and 120 Path B, strategy C, `adjudicate-v3`. $1.9269132, peak 10, no failures. 0 direct or inferential findings; 274 likely compatible, 6 insufficient, 20 for review. Analysis 11 (pair retrieval) also found none. Without labels, this can't distinguish no contradictions from missed ones.

## October 31: multi-model experiment harness (no external model calls)

Built `experiments/multimodel-contradictions/`: shared prompts, one output schema, adapters, a gate that defaults to dry runs, citation verification, comparison and review export. Verified provider facts from their documentation. Token counts are local, because the count-tokens endpoint would upload transcript text. Production code is unchanged. Provider adapters are untested against live services.

## October 31: first synthetic discovery benchmark (approved, arm C $0.75 limit)

Arm C only: Sonnet 5.5 read each fixture's two sessions, one call each, with no retrieval. Probe plus 2 discovery calls, $0.125594. 6 of 7 known contradictions proposed as conflicts, and the seventh located but marked uncertain. Arm A stayed off because OpenCode's terms are unclear on automated use. Arm B had no API key. Arm D has no stored live discovery on these transcripts.

## October 31: full Ellison direct reading (approved, $2.00 limit)

One Sonnet 5.5 call on all 5,603 lines (103,393 input tokens by count_tokens). $0.2183045, 9 seconds, 1,052 output tokens, no truncation or error. 0 proposed contradictions; 2 findings, both compatible. Results in `experiments/multimodel-contradictions/review/ellison-verified.json` (git-ignored). Both findings cite only pages 99-148 of P3171 and 61-129 of P3173, so the run says little about the rest of the testimony. Its `complete` status is the model's own claim.

## October 31: OCR for scanned depositions (approved)

Added local OCR with Tesseract and Poppler (`ingest/ocr.ts`, migration 0016). The text-layer route is unchanged. Tested on all five public Gates excerpts (109 pages).

What the agent got wrong, and what caught it: a fixed gutter position failed on pages the scanner had shifted; the footer's phone number was read as a page number; a hand check against page images found a misread "A." that gave the witness's answer to the attorney, and a gutter digit stored as testimony; a test caught the marker fix rewriting correct text. Confidence scores flagged none of the last two: reading the images did.

## October 31: Gates experiment and first full upload-to-findings run (approved, $2.00 limit)

`gates8a` (Vol. II, August 28, 1998) and `gates8d` (Vol. III, September 2, 1998) were confirmed as separate sessions of one witness from their covers. Both were uploaded through the live API and worker, OCR'd in 8 seconds, and analyzed in hybrid mode (analysis 13): 112 pairs, $0.7124, 75 seconds, no failures, 0 potential contradictions. Direct Sonnet on the same 400 lines: $0.0248, 5 seconds, 1 finding, compatible. Added `GET /depositions/:id/pdf` and `pdfPage` on evidence lines.

Path A contributed no pairs: Haiku flagged 33 of 45 `gates8a` exchanges, and all 9 topics covered one session.

## October 31: frontend brought into v2-backend, browser check (approved)

The frontend's working changes were applied to `v2-backend` as uncommitted edits; nothing is committed, and no git merge happened. Real Chrome against the live API and the real Gates case: OCR labels, per-line confidence, low-confidence flags, the scan dialog at the right PDF page, and the inferred-page warning on screen and in the copied citation all worked, with no console errors. A patch of the backend's earlier state is in the session scratchpad.

## October 31: one pipeline (approved)

Removed the claims pipeline, batching, v1 and the scripts built on them, keeping hybrid and the direct experiment. The compiler caught one mistake: three spike files that looked obsolete are the independent readers behind the PDF accuracy test, so they were restored.

## November 1: direct discovery as the default (approved sprint brief)

Speaker attribution fixed first: hearing-style labels, redacted speakers and near-miss labels, with OCR text kept separately. Direct Fable discovery added as the default for live analyses, with `discovery_runs`, a one-time refusal fallback, deterministic verification, lanes and deduplication. Hybrid stays non-default. Migrations 0018-0020 are additive. Frontend shows lanes, model provenance and proposals that couldn't be checked. All provider tests use mocks.

No paid call was made for the integration. Browser check used a replay of the saved November 1 Fable answer on the corrected Hutchinson parse (analysis 16, case "Hutchinson parser r2", dev database only), which records that answer's $1.65 again on a local row although nothing was billed. The paid synthetic benchmark has not run. Nothing committed or pushed.

## November 1: evidence strength (approved)

Added the five-point `evidence-strength-v1` checklist for direct findings, with no model call and no prompt change. Rescored saved analyses 16 and 18 from stored data; hybrid rubric v1 scores unchanged. The benchmark's output cap went up to 64,000 after a 24,000 cap cut off Whitfield. The paid synthetic run cost $1.18: Webb found 3 of 3, Whitfield failed at the cap and is not a measurement. Nothing committed or pushed.

## November 1: priority no longer comes from the score (approved)

High came from the evidence-strength score alone, which put the Webb home-versus-parking-lot false positive at High. Priority now comes from the lane, the model's classification and code's checks, and the score only orders findings. The five checks and their weights are unchanged. Saved analyses 16 and 18 rescored from stored data. That finding stays a Potential contradiction at Medium: Fable classed it inferential, so it is a semantic false positive from discovery that code can't remove. Nothing committed or pushed.

## November 1: review fixes for direct discovery (approved)

Three review findings fixed. A failed batch check keeps polling for about five minutes, then closes the run and counts its reservation in full. Active-analysis reuse now matches the method. A direct analysis resumes only when it can make progress, and otherwise returns 409. Nothing committed or pushed.

## November 1: frontend rebuilt to the Stitch screens (approved)

Three screens below a slim top bar, no sidebar: Cases, Case and Report with Finding. The dashboard, depositions, analyses, findings and review pages are gone. Review decisions now save to the server and carry forward. Stitch's invented compliance claims, metrics and external fonts were left out. Text upload, paste, export and removing a deposition are not built yet. Nothing committed or pushed.
