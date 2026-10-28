# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

The repo holds **v1**: a single-request app that compares two short `Q:`/`A:` transcripts. We are building **v2** (due Tue Nov 3, 2026): real page:line depositions, two-path candidate retrieval, Postgres + background workers, a versioned scoring rubric, measured cost, and the Contradiction Workbench UI.

`DESIGN.md` is the approved v2 spec and the source of truth for schemas, interfaces, the rubric, test cases and the day-by-day plan. Read the relevant section before starting a feature. If the code, this file and `DESIGN.md` disagree, stop and ask rather than picking one. Don't change approved decisions (rubric v1, default budgets, parser fallback, pair scope) without being asked.

Trade-offs follow this order: correct evidence, reliable retrieval, defensible adjudication, excellent UI, measured cost, demonstrable scalability. Stretch-backlog features start only after every acceptance criterion in `DESIGN.md` passes.

## Commands

- `npm install`: installs root deps; `postinstall` also installs `client/` deps.
- `npm run dev`: runs the Express server (`tsx watch`, port 3001) and the Vite client (port 5173, proxies `/api` to 3001) together.
- `npm test`: Vitest unit tests in `tests/`. Single file: `npx vitest run tests/verify.test.ts`; single test: `npx vitest run -t "<test name>"`.
- `npm run typecheck`: `tsc --noEmit` over `server/`, `scripts/`, `tests/` (not the client).
- `npm run build --prefix client`: typechecks and builds the client.
- `npx tsx scripts/try.ts`: runs a full v1 analysis of the sample transcripts from the CLI (needs `ANTHROPIC_API_KEY`).

Requires Node 20+ and a `.env` with `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`, defaults to `claude-sonnet-5-5`). See `.env.example`. When v2 adds Docker Compose, migrations, the worker process, eval scripts or k6, add their commands here.

Run `npm run typecheck` and `npm test` before every commit.

## Non-negotiable rules

These hold in v1 and v2. Code that breaks one is a bug, even if tests pass.

- **Claude proposes, the app scores.** Claude returns classifications, IDs, key phrases and categorical observations only, never a confidence, score, band, probability or certainty. Verdict schemas are strict, so an extra key like `confidence` fails validation. All scores, bands and priorities come from pure TypeScript.
- **Quotes shown to the user come from stored source text, never from model output.** The model's key phrase is only used to verify the citation.
- **Every citation passes the evidence gate.** Invalid IDs, wrong references and fabricated phrases never become scored or verified findings; they go to the "check manually" section with no score.
- **The time check never changes the classification.** It only caps or adjusts the score, and in v2 it runs only when the verdict says the conflict is about timing.
- **Model calls are server-side only.** The client never calls Anthropic, and the API key is read only on the server. In v2, only `claims/` and `adjudicate/` call a model, and every call goes through `costs/` (`recordCall`, `assertBudget`).
- **Label origins honestly.** In the UI and README, model output is labelled as Claude's and code checks as checks. Never say a witness is lying. Report synthetic fixtures separately from real testimony, print n next to every metric, and never present DOJ HTML ingestion as proof that PDF parsing works.

## Testing conventions

- Put logic in pure functions (no I/O, clock or randomness) and test them with hand-built inputs, so tests need no API key or database.
- v2 scoring is test-first: commit the `DESIGN.md` scoring test cases (and the `readAnswer` table) failing, then implement `score()` and `prioritize()`. Tests assert the full `Assessment`, not just the total.
- All weights, caps and thresholds live in one frozen `RUBRIC_V1` object. Any change ships as a new rubric version, with the reason in the README.

## v1 architecture (current code)

Pipeline for `POST /api/analyze` (`server/src/index.ts`):

1. `transcript.ts`: `parseTranscript(text, "T1")` splits `Q:`/`A:` text into `QAPair`s with IDs like `T1-3`. *v2: replaced by `ingest/`.*
2. `claude.ts`: `findCandidates` makes one Messages API call with structured outputs (`output_config.format`, JSON schema generated from the zod schema in `schema.ts`), re-validates with zod, and throws on `max_tokens`/`refusal`. *v2: same pattern, new schemas.*
3. `analyze.ts`: `analyze()` runs `findCandidates` `RUNS` (3) times via `Promise.allSettled` (failed runs tolerated), then `scoreFindings()`, a pure function, groups the same ID pair across runs, takes the majority type (ties break toward caution: false_positive > inferential > direct), applies the evidence gate and time check, scores, and sorts by priority. *v2: voting and `majorityType`/`startingScore` are removed; `findQuoteElsewhere`, `toBand` and `toPriority` ideas carry over.*
4. `verify.ts`: quote verification. Normalized match within the cited answer; exact = 1.0, word overlap ≤ 0.9, stopwords ignored. Below `EVIDENCE_GATE` (0.6) the finding is `unverified` with `confidence: null`. *v2: `quoteMatchScore` becomes the key-phrase check in Layer 1.*
5. `ambiguity.ts`: `compareTimes` turns time mentions into ranges (hedged ±30 min, precise ±5, AM/PM tried both ways, 24h wraparound) and says whether times support or challenge the label. *v2: kept as-is.*

v1 scoring constants (starting scores 90/65/35, −15 paraphrase, +10 time support, cap 60 on time challenge, bands 75/50) and their rationale are in `README.md`; keep README in sync when changing them. Tests in `tests/` exercise `scoreFindings` with hand-built `Candidate`s against `server/src/data/samples.ts` (Marcus Webb and Elena Ruiz). Those samples stay in v2 as labelled synthetic fixtures.

## v2 target layout

A modular monolith: one repo, an API process and a worker process sharing modules under `server/src/`, each with one public entry point. Postgres (pgvector, full-text search) holds all state, and pg-boss runs the job queue. No user request waits on a model call.

| Module | Responsibility |
| --- | --- |
| `ingest/` | PDF (or DOJ HTML fallback) to `lines` and `exchanges` with page:line; counts pages with no text layer (no OCR); idempotent per `file_sha256` + `parser_version` |
| `claims/` | Path A claim tagging (Haiku); its failure never blocks Path B |
| `retrieve/` | `pathA.ts`, `pathB.ts` (full text, `rare_terms` / `all_terms`), `pathE.ts` (embeddings, off by default), `merge.ts` (dedupe, RRF k=60, per-exchange cap, budget, audit sample) |
| `adjudicate/` | Evidence packets, Sonnet call, verdict schema validation |
| `verify/` | Layer 1 source checks and Layer 2 attribution, including `readAnswer` in `answers.ts`; pure |
| `score/` | `RUBRIC_V1` in `rubric.ts`, `score()`, caps, bands, `prioritize()`; pure |
| `costs/` | Versioned price table (`pricing.ts`), `recordCall`, estimator, budget guard |
| `jobs/` | pg-boss queues, `job_stages` resume by input hash, ledger counts, per-org limits |
| `api/` | Read endpoints with keyset pagination, review actions, estimates |
| `eval/` | recall@K per path, precision per band, citation validity, Q/A accuracy, cost |

Backend conventions: every table carries `org_id`/`case_id` and list queries use an index that starts with them; keyset pagination, never `OFFSET`; dashboard counts come from `case_summary`, not `COUNT(*)`; source lines load one page window at a time; zod at every boundary.

## Client

`client/` is a separate Vite + React package with its own `package.json` and tsconfig. `client/src/types.ts` hand-duplicates the server's response types (it does not import from `server/`), so update both when the API shape changes. The v2 Workbench uses Tailwind and shadcn/ui. Classification is shown by colour plus a text label, never colour alone, and citations use page:line.

## Workflow

- One feature per branch and pull request; start non-trivial features in plan mode.
- After each feature, add an entry to `docs/agent-log.md`: the prompt, what the agent got wrong, and what was changed.
- Tick off the day's items in the `DESIGN.md` build plan when they land.
