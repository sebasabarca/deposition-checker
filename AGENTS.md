# AGENTS.md

Instructions for Codex working in this repository. Claude Code (`CLAUDE.md`) is the lead; Codex usually takes a delegated task with an explicit brief (below). Both read the same shared docs, so this file stays short.

## The project in three lines

Veridict finds possible contradictions in a witness's sworn testimony across deposition sessions. A model classifies small evidence packets; TypeScript verifies every citation against the stored transcript lines and scores with a fixed rubric; a lawyer reviews each finding at its page:line. Priorities, in order: correct evidence, reliable retrieval, defensible adjudication, UI, measured cost, scalability.

## Read only what the task needs

- `docs/architecture.md`: what every module and file does.
- `docs/commands.md`: every command; marks the paid ones.
- `docs/roadmap.md`: milestones. `DESIGN.md`: the approved design (large: search it, don't read it whole).
- `docs/setup.md`: install, database, tests.

Stack: Node 24 (`.nvmrc`), TypeScript strict with `nodenext` modules run by `tsx`, Express 5, Postgres 16 through Drizzle, pg-boss, Vitest, zod 4; the client is React 19 + Vite in `client/`.

## Rules that are never relaxed

- Every displayed quotation comes from stored transcript lines, never from model output. A model-generated citation is verified by code before it is used; unverified ones get no score.
- The model classifies; code scores. No model output contains a confidence, score or probability.
- Only `server/src/claims/` and `server/src/adjudicate/` call a model, and every call goes through `costs/` (`recordCall()`, budget reservation).
- No paid model calls: leave `ALLOW_PAID_CALLS` unset. A task that needs one stops and says so.
- Never discard failed or unprocessed evidence: count it and report it.
- Don't change frozen benchmark files, labels in `data/eval/` or files under `data/raw/` to make a test pass.
- Don't commit, push, rewrite history, drop or truncate tables, or delete files you didn't create. `TEST_DATABASE_URL` (and the per-worker databases derived from it) is wiped by DB tests: use only the one your brief gives you.
- Never commit `.env`, transcripts, anything under `data/raw/` or `data/uploads/`, or model files.

## Conventions

Named exports, `type` aliases, `camelCase` functions, `UPPER_SNAKE` constants at the top of a file. Logic goes in pure functions tested with hand-built inputs (no API key or database). Validate external data with zod. No new dependency without saying why. `client/src/types.ts` duplicates server response types: update both. A schema change needs `npm run db:generate` and the generated SQL reviewed.

## A delegated task

Each brief states: objective; the files or modules you may change (touch nothing else); acceptance criteria; the tests to run; budget and restrictions; the output format. If a brief is missing one of these, or the task needs a file outside its list, stop and ask rather than widen the scope.

While implementing, run `npm run test:fast` (unit tests related to your changes) and `npm run test:integration` (related Postgres tests). Before finishing, run the brief's tests, `npm run test:full` and `npm run typecheck` (plus `npm run build --prefix client` for client changes). Use Node 24: `nvm use`. Report counts, not logs.

Reply with a compact summary, not terminal logs:

```
Status: done | blocked | partial
Changed: <file>: <one line each>
Tests: <command> -> <passed/failed counts>
Acceptance: <each criterion: met / not met, with the evidence>
Not done or uncertain: <list, or "none">
```

The implementing agent does not certify its own results: the lead or an independent reviewer checks acceptance.
