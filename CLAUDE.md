# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Deposition Checker finds potential contradictions in a witness's sworn testimony across deposition sessions. Claude reads small evidence packets and classifies candidate pairs as direct, inferential or false positive. Code then checks every citation against the stored transcript and calculates a confidence score with a fixed, explainable rubric. A lawyer reviews each finding with both passages shown side by side at their page:line.

This is **v2**, which handles real page:line depositions with background jobs, measured cost and a review workbench. A live analysis defaults to direct discovery: Claude Fable 5.1 reads both sessions whole and proposes findings, then code verifies every citation and sorts each into a lane. Hybrid retrieval with Sonnet adjudication, deterministic verification and scoring remains as the non-default `method: "hybrid"`, and demo mode replays its stored verdicts. v1 and the earlier claims pipeline were removed on October 31, after validation, on the developer's instruction. `DESIGN.md` is the approved v2 plan and the source of truth for the planned architecture. Planned v2 modules do not exist yet unless you find them in the repo.

Development priorities, in order: correct evidence, reliable retrieval, defensible adjudication, excellent UI, measured cost, demonstrable scalability.

## Technology stack

**Current (v1):**
- Node 22.12+ (`.nvmrc` selects 24; pg-boss 12 requires it), TypeScript (strict, `nodenext` modules), run with `tsx`
- Express 5 API server (`server/`)
- Anthropic SDK (`@anthropic-ai/sdk`) with structured outputs, validated with zod 4
- Vitest for unit tests
- Client: React 19 + Vite 8, a separate package in `client/`
- `pdfjs-dist` for PDF text extraction (chosen by the parser spike; see `docs/parser-spike.md`)
- Tesseract and Poppler for scanned PDFs, run as local tools (`brew install tesseract poppler`); without them scanned pages stay `needs_ocr`
- Postgres 16 (with pgvector available) in Docker Compose, accessed through Drizzle ORM (`drizzle-orm`, `drizzle-kit`, `pg`)
- pg-boss job queue (in Postgres), with the API and the ingest worker as separate processes

**Approved v2 additions (from `DESIGN.md`, not yet installed):**
- Tailwind 4 is installed in `client/`, with the approved design's tokens in `client/src/index.css`. shadcn/ui is not: components are hand-written in `client/src/components/ui.tsx`, with no Radix dependency. Public Sans, Source Serif 4 and Courier Prime (`@fontsource`) and icons (`lucide-react`) are bundled, so the browser makes no third-party request
- k6 for load testing

## Repository map and commands

Shared by Claude Code and Codex (`AGENTS.md`); read the part you need, not the whole file:

- `docs/architecture.md`: what every module and file does. Read it before adding a module, and keep it current when you add or move one.
- `docs/commands.md`: every script and command, with which ones are paid. Add a command there only once it exists and works.
- `docs/roadmap.md`: the seven milestones and where we are. `docs/setup.md`: a fresh install.

The modules, all under `server/src/`: `ingest/` (files to page:line rows), `evidence/` (Stage 1 index, eligibility, audit and correction), `claims/` (cards, topics, Stage 2 facts), `retrieve/` (Path A/B, independent paths, MiniLM, factual, frozen benchmarks, triage, grouping), `adjudicate/` (packets, Sonnet adjudication, direct and cross discovery), `verify/` and `score/` (pure checks and the rubric), `costs/` (prices, `recordCall()`, budgets), `jobs/`, `api/`, `eval/`, `db/`. The client is `client/src/`. Only `claims/` and `adjudicate/` may call a model, and every such call goes through `costs/`.

The everyday commands:

- `npm run dev`: API (3001), worker and client (5173). `npm run db:up` / `npm run db:migrate` first.
- Tests: `npm run test:fast` (unit tests related to your changes) and `npm run test:integration` (related Postgres tests) while implementing; `npm run test:full` (about 27 s) before integrating a task and at milestone integration and completion. Plus `npm run typecheck`, and `npm run build --prefix client` for client changes. Details: `docs/commands.md`, "Tests"
- `npm run db:generate` after changing `server/src/db/schema.ts` (review the SQL, then commit it)
- `npx tsx scripts/evidence.ts eval-real` and `npx tsx scripts/facts.ts eval-real`: real-data evaluations (wipe `TEST_DATABASE_URL`)

Requires a `.env` with `ANTHROPIC_API_KEY`, `DATABASE_URL` and `TEST_DATABASE_URL`. Live analyses call a model only when `ALLOW_PAID_CALLS=true` is also set; leave it unset in development and tests. Any command that calls a model runs only with the developer's approval and a stated USD limit.

## Architectural rules

- **Follow `DESIGN.md`.** If code and design disagree, say so and ask. Never change the design silently.
- **Keep API requests separate from long-running analysis.** Analysis runs in background jobs, and API requests only read stored rows.
- **Never call an AI model from the client.** The API key is read only on the server.
- **Every displayed quotation comes from stored transcript source lines,** never from model output.
- **Never trust a model-generated citation without verification.** Unverified citations get no score and go to a "check manually" section.
- **Claude classifies, TypeScript scores.** Claude never returns a confidence, score, band or probability, and strict schemas reject such keys. All scoring lives in pure functions, with weights in a versioned rubric.
- **Keep model interpretation separate from deterministic verification,** in code, in the database and in the UI labels.
- **Record every AI call's token usage and cost** with `recordCall()` from `costs/`. 
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

## Frontend design

Use both design skills for any work on the frontend (`client/`), including new screens, redesigns, restyling, polish and UI review:

- **Impeccable:** `.agents/skills/impeccable/SKILL.md`
- **Taste:** `.agents/skills/design-taste-frontend/SKILL.md`

Read both `SKILL.md` files before writing frontend code, and follow them. They live under `.agents/`, so open them by path if they aren't listed as available skills. They don't override the architectural rules above: testimony is always the stored lines, and model output stays labelled as model output.

## Coding conventions

- Follow the existing TypeScript style: named exports, `type` aliases, `camelCase` functions, `UPPER_SNAKE` constants at the top of the file (see `analyze.ts`).
- Put logic in pure functions (no I/O, clock or randomness) and test them with hand-built inputs, so tests need no API key or database.
- Validate external data with zod at every boundary.
- Prefer clear, maintainable code over unnecessary abstractions.
- Don't add dependencies without explaining why they are needed.
- `client/src/types.ts` hand-duplicates the server's response types, so update both when the API shape changes. Client tests (`tests/client/`) run under vitest but are excluded from the root typecheck; `npm run build --prefix client` checks them.
- Keep the scoring constants in `README.md` in sync with the code.

## Delegating to Codex and subagents

Claude Code leads: architecture, experiment design, integration, reviewing significant changes and resolving conflicting findings. Codex (`codex exec`, signed in with the developer's ChatGPT account, no API key) takes well-scoped work: TypeScript in one module, tests, local refactors, database integration, bug fixes. Its brief format and reply format are in `AGENTS.md`; every brief names the objective, allowed files, acceptance criteria, tests, budget and restrictions, and output format. Parallel tasks run in separate git worktrees with disjoint files, each with its own `TEST_DATABASE_URL` (for example `…/deposition_checker_agent_a_test`; the test workers' databases derive from it, so two worktrees never touch the same one). An independent reviewer, not the implementer, checks acceptance. No agent pushes, commits without approval or makes paid model calls.

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

## graphify (optional navigation aid)

`graphify-out/graph.json` is a local AST graph of `server/`, `scripts/`, `tests/` and `client/` (`.graphifyignore` leaves out the rest; no model calls, built with network access blocked; git-ignored). Use it to locate a symbol or its callers: `graphify query "<question>"`, `graphify explain "<symbol>"`, `graphify path "<A>" "<B>" --undirected`. It doesn't see data flow through database tables, and barrel `index.ts` files give misleading short paths, so for "how does data get from X to Y" read the imports and the table writes directly. Refresh it after code changes with `graphify update .` (about 3 seconds). Measured on November 3 (`docs/baseline-m1.md`): not a token saving for data-flow questions.
