# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Deposition Checker finds potential contradictions in a witness's sworn testimony across deposition sessions. Claude reads small evidence packets and classifies candidate pairs as direct, inferential or false positive. Code then checks every citation against the stored transcript and calculates a confidence score with a fixed, explainable rubric. A lawyer reviews each finding with both passages shown side by side at their page:line.

The repo holds **v1**, which compares two short `Q:`/`A:` transcripts in one request. We are building **v2**, which handles real page:line depositions with background jobs, measured cost and a review workbench. `DESIGN.md` is the approved v2 plan and the source of truth for the planned architecture. Planned v2 modules do not exist yet unless you find them in the repo.

Development priorities, in order: correct evidence, reliable retrieval, defensible adjudication, excellent UI, measured cost, demonstrable scalability.

## Technology stack

**Current (v1):**
- Node 20+, TypeScript (strict, `nodenext` modules), run with `tsx`
- Express 5 API server (`server/`)
- Anthropic SDK (`@anthropic-ai/sdk`) with structured outputs, validated with zod 4
- Vitest for unit tests
- Client: React 19 + Vite 8, a separate package in `client/`
- `pdfjs-dist` for PDF text extraction (chosen by the parser spike; see `docs/parser-spike.md`)
- Postgres 16 (with pgvector available) in Docker Compose, accessed through Drizzle ORM (`drizzle-orm`, `drizzle-kit`, `pg`)

**Approved v2 additions (from `DESIGN.md`, not yet installed):**
- pg-boss job queue, with the API and the worker as separate processes
- Tailwind and shadcn/ui for the Workbench UI
- k6 for load testing

## Repository structure

**Existing:**
- `server/src/index.ts`: Express app with `POST /api/analyze`
- `server/src/transcript.ts`: `Q:`/`A:` parser (replaced in v2)
- `server/src/claude.ts`, `schema.ts`: the Claude call and its zod schema (the pattern is reused)
- `server/src/analyze.ts`: three runs, majority vote and scoring (voting is removed in v2)
- `server/src/verify.ts`: quote matching (`normalize`, `quoteMatchScore`), reused in v2
- `server/src/ambiguity.ts`: time-range comparison, reused as-is in v2
- `server/src/data/samples.ts`: Marcus Webb and Elena Ruiz samples, kept as synthetic fixtures
- `tests/`: Vitest tests for the pure functions above
- `scripts/try.ts`: runs a v1 analysis from the CLI
- `scripts/ingest.ts`: ingests one deposition PDF into Postgres from the CLI (development only); `scripts/cases.ts` finds or creates its case and witness by name
- `client/src/`: the v1 single-page UI
- `server/src/ingest/`: v2 PDF ingestion: extraction, per-page validation against the `ellison-doj-v1` layout, speakers, exchanges and long-answer parts (pure functions); `rows.ts` maps them to database rows, `store.ts` saves a deposition in one transaction, `uploads.ts` keeps PDFs under `data/uploads/` by SHA-256, and `ingestFile` in `index.ts` runs all three
- `server/src/db/`: Drizzle schema (`schema.ts`) and connection (`client.ts`); migrations generated into `drizzle/`
- `docker-compose.yml`, `docker/postgres-init/`: local Postgres, plus a separate `deposition_checker_test` database for the test suite
- `scripts/spike/`: the parser spike, kept as the record behind `docs/parser-spike.md`; production code lives in `server/src/ingest/`
- `docs/agent-log.md`: log of agent sessions

**Planned v2 modules** (folders under `server/src/`, each with one public entry point; see `DESIGN.md`, Modules section): `ingest/`, `claims/`, `retrieve/`, `adjudicate/`, `verify/`, `score/`, `costs/`, `jobs/`, `api/`, `eval/`. Only `claims/` and `adjudicate/` may call a model, and every such call goes through `costs/`.

## Development commands

- `npm install`: installs root deps; `postinstall` also installs `client/` deps
- `npm run dev`: server (`tsx watch`, port 3001) and Vite client (port 5173, proxies `/api` to 3001)
- `npm test`: all Vitest tests in `tests/`
- `npx vitest run tests/verify.test.ts`: one test file
- `npx vitest run -t "<test name>"`: one test
- `npm run typecheck`: `tsc --noEmit` over `server/`, `scripts/` and `tests/` (not the client)
- `npm run build --prefix client`: typechecks and builds the client
- `npx tsx scripts/try.ts`: v1 analysis of the samples (needs `ANTHROPIC_API_KEY`)
- `npm run db:up` / `npm run db:down`: start or stop Postgres in Docker
- `npm run db:generate`: write a new SQL migration to `drizzle/` after changing `server/src/db/schema.ts` (review the SQL, then commit it)
- `npm run db:migrate`: apply migrations to the database in `DATABASE_URL`
- `npx tsx scripts/ingest.ts <file.pdf> --case <name> --witness <name> [--taken-on YYYY-MM-DD]`: ingest one PDF into the database in `DATABASE_URL`; re-running it on the same file replaces that deposition's rows instead of duplicating them
- Database tests in `tests/db/` run only when `TEST_DATABASE_URL` is set (they wipe that database, whose name must end in `_test`); otherwise they are skipped. They share one database, so `vitest.config.mts` runs test files one at a time

Requires a `.env` with `ANTHROPIC_API_KEY`, `DATABASE_URL` and `TEST_DATABASE_URL`, and optionally `ANTHROPIC_MODEL` (defaults to `claude-sonnet-5-5`). See `.env.example`, whose database URLs match `docker-compose.yml`. Add new commands here only once they exist and work.

## Architectural rules

- **Follow `DESIGN.md`.** If code and design disagree, say so and ask. Never change the design silently.
- **Keep API requests separate from long-running analysis.** Analysis runs in background jobs, and API requests only read stored rows.
- **Never call an AI model from the client.** The API key is read only on the server.
- **Every displayed quotation comes from stored transcript source lines,** never from model output.
- **Never trust a model-generated citation without verification.** Unverified citations get no score and go to a "check manually" section.
- **Claude classifies, TypeScript scores.** Claude never returns a confidence, score, band or probability, and strict schemas reject such keys. All scoring lives in pure functions, with weights in a versioned rubric.
- **Keep model interpretation separate from deterministic verification,** in code, in the database and in the UI labels.
- **Record every AI call's token usage and cost.**
- **Preserve page and line references** from ingestion through to display.
- **Never silently discard failed or unprocessed evidence.** Count it and show it: pages with no text layer, failed batches, deferred candidates.

## Development workflow

For each feature:

1. Read the relevant section of `DESIGN.md`.
2. Inspect the existing implementation.
3. Explain the proposed approach.
4. Identify the affected files.
5. Wait for approval before implementing significant changes.
6. Implement only the approved scope.
7. Add or update tests.
8. Run the relevant tests and `npm run typecheck`.
9. Summarize the changes and their limitations.

## Coding conventions

- Follow the existing TypeScript style: named exports, `type` aliases, `camelCase` functions, `UPPER_SNAKE` constants at the top of the file (see `analyze.ts`).
- Put logic in pure functions (no I/O, clock or randomness) and test them with hand-built inputs, so tests need no API key or database.
- Validate external data with zod at every boundary.
- Prefer clear, maintainable code over unnecessary abstractions.
- Don't add dependencies without explaining why they are needed.
- `client/src/types.ts` hand-duplicates the server's response types, so update both when the API shape changes.
- Keep the scoring constants in `README.md` in sync with the code.

## Git workflow

- Work on one feature at a time.
- Don't modify unrelated files.
- Don't commit unless explicitly asked.
- Never rewrite Git history or discard existing work without permission.
- Summarize the changes before suggesting a commit.

## Communication preferences

The developer is a Computer Systems Technology student learning to work with AI coding agents, and wants to understand the system being built. When proposing significant changes:

- Explain the reasoning in straightforward language.
- Explain the important trade-offs.
- Say what is new and what is reused from v1.
- Avoid unnecessary technical complexity.
- Ask for approval before deviating from `DESIGN.md`.
