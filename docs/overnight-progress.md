# Overnight progress: Deposition Checker v2 sprint (started October 30, 2026)

Resume point for an interrupted session. Concise and factual; newest state first within each phase.

**Ground rules:** no paid API calls, no commits or pushes, no deleting data, no dropping the database, frozen rubric v1, no retrieval changes.

## State at sprint start

- Branch `feature/path-a-claims`, everything uncommitted.
- 444 tests passed and typecheck was clean. The client build failed (a `client/tsconfig.json` problem).
- Already present:
  - ingestion (PDF, worker, upload, status and retry endpoints);
  - Path A and Path B retrieval and the merge;
  - adjudication v1, v2 and v3 (prompts; v3 not run);
  - Layer 1 and Layer 2 verification, scoring, budgets;
  - the synthetic suites `webb-synthetic-v1` (#2988–2993) and `whitfield-synthetic-v1` (#3004–3013).
- **Paid calls so far:** 18 Sonnet calls ($0.138) and the earlier Haiku tagging. None in this sprint.

## Phase 1: stabilize (done)

- **1.1 Inference rule.** The steps together must cite both exchanges (chain level), and each step must cite only real packet IDs. A new issue, `inference_step_unverified_evidence`, gates scoring, per CLAUDE.md's rule for unverified citations. The rubric's step-points rule is unchanged and tested through `score()`. Tests are in `tests/score/cases.test.ts` and `tests/adjudicate/prompts.test.ts`.
- **1.2 Page break.**
  - The parser is correct: an existing test keeps a Q/A across a page break, and `validate.ts` rejects lines beyond `maxLinesPerPage`.
  - The cause was the fixture: `toSourceLines` numbered up to 25 lines on a 22-line layout, and `storeSynthetic` hand-wrote a "ready" validation, so the check never ran.
  - Fixed: the fixture now uses the layout's page length, and `storeSynthetic` runs the real `validateDeposition`.
  - Regression tests: `tests/eval/synthetic.test.ts` (Q at 10:22, A at 11:01, one exchange).
  - The Whitfield fixture was re-stored as #3004–3013 (it had no verdicts). Webb's page:line references were unaffected.
- **1.3 adjudicate-v3** is complete:
  - grounding, context-use, conflict-source and inference checks;
  - v1 and v2 prompts pinned by SHA-256 (`tests/adjudicate/prompts.test.ts`);
  - v3 is v2 plus the grounding section, verified by test.
- **1.4 Client build.** `client/tsconfig.json` had held a copy of the root tsconfig since commit ca820b1. It's restored to the Vite project references, and `npm run build --prefix client` passes.
- **Result:** 447 tests pass, typecheck is clean, the client build passes. Dev DB data is intact: 7 depositions, 18 verdicts, 18 findings, 86 llm_calls.

## Phase 2: backend workflow (done)

- **Migration 0011 (applied to the dev DB):**
  - the `analyses` table, with status queued | parsing | retrieving | adjudicating | completed | failed | blocked_budget | blocked_credentials, plus progress counts, budget, mode and errors;
  - `verdicts.origin` (model | replayed | fixture), `verdicts.replay_of`, and `llm_call_id` nullable (a check ties a call to origin=model);
  - `depositions.original_filename`.
- **`adjudicate/run.ts`:** `storeVerdict()` is extracted and shared by live calls and demo replays, so both go through the same verification and scoring.
- **`adjudicate/replay.ts` (demo mode):** replays a stored valid model verdict for the same pair of exchanges, else a synthetic fixture's prepared verdict, else no verdict (counted). It never calls a model.
- **`jobs/analysis.ts`, `runAnalysis()`:**
  - waits for parsing (bounded at about 10 minutes);
  - retrieval: Path A from stored claims (no new tagging) plus Path B, kept to the pair, selected and persisted as `analysis-<id>`;
  - adjudication: demo replays; live runs under the analysis budget;
  - stops on `BudgetExceeded` (`blocked_budget`), on missing credentials before any call (`blocked_credentials`), or after 3 consecutive call failures (`failed`);
  - idempotent on re-run.
- **`jobs/queue.ts`, `jobs/index.ts`:** the `run-analysis` queue (singletonKey per analysis, 2 retries, dead letter marks it failed), and `startAnalysisWorkers`. The worker runs ingest and analysis.
- **Paid calls need both `ANTHROPIC_API_KEY` and `ALLOW_PAID_CALLS=true`** (`paidCallsAllowed`). Not set in `.env`, so off in development.
- **API:**
  - `api/cases.ts`: GET/POST `/cases`, GET `/cases/:id`, POST `/cases/:id/witnesses`;
  - `api/analyses.ts`: POST/GET `/cases/:id/analyses`, GET `/analyses/:id`, POST `/analyses/:id/resume`, GET `/analyses/:id/findings` (grouped), GET `/findings/:id` (both sides' stored lines, context, highlights, verification, attribution, factors, caps, source label);
  - `api/present.ts`: grouping and labels;
  - the upload keeps `filename` (basename only).
- **Tests:**
  - `tests/db/analysis.test.ts` (9): demo replay, idempotency, credentials, budget block and resume, invalid response, failures, parsing wait, failed deposition;
  - `tests/db/workflow-api.test.ts` (6): includes a real end to end that uploads the two Ellison PDFs, parses them, runs a demo analysis and reads the case.
- **Result:** 462 tests pass, typecheck is clean.
- **Known:**
  - a demo of real Ellison testimony replays only the 6 stored v1 verdicts (#1, 2, 4, 17, 49, 105) when retrieval selects those pairs;
  - Path A doesn't tag new uploads (paid); retrieval for new uploads is Path B only.

## Phase 3: lawyer-facing UI (done)

- **Dependencies:** Tailwind 4.3.3 (`tailwindcss`, `@tailwindcss/vite`, dev only, pinned). shadcn/ui is not installed: it needs Radix and its generator. Small components in its style are hand-written in `client/src/components/ui.tsx`.
- **v1 analyzer:** kept as `ClassicApp` at `#/classic`. Its global CSS is scoped under `.classic` (`classic.css`), so it no longer overrides the v2 layout.
- **Routing:** hash routes, no router dependency (`client/src/lib/router.ts`): `#/`, `#/cases/:id`, `#/analyses/:id[/findings/:fid]`, `#/classic`.
- **Pages:**
  - `CasesPage`: list and create;
  - `CasePage`: sessions table (status, date, file, pages), upload (client-side 50 MB check), compare-two-sessions form (Demo or Live with budget), analyses list. It polls while anything is running.
  - `AnalysisPage`: four-step progress from stored counts (no percentages), mode and cost line, stop and resume controls, findings in four sections;
  - `FindingView`: both passages side by side, verbatim stored lines with page:line, cited lines highlighted, exchange shaded, context greyed, page gaps marked; then the model's explanation (labelled), alternative, how it was checked (verification, attribution, disagreements, time check, consistency issues), and "Why this score?" (factors with origin, caps, not corroborated).
- **Labels:** plain language in `client/src/lib/labels.ts`. Scores read "Assessment support: N/100" or "Support for 'compatible'", never a probability. Demo findings show a banner: replayed stored Sonnet assessment, or a prepared example, not produced by a model.
- **Server:** case and finding counts now include only findings belonging to analyses.
- **Checked visually** with headless Chrome at 1440px and at a true 390px (iframe; headless Chrome's minimum window is 500px).
- **Tests:** `tests/client/labels.test.ts` and `tests/api/present.test.ts`. `tests/client` is excluded from the root typecheck (the client build checks it).
- **Demo data in the dev DB (additive):**
  - analysis #1: Ellison demo, 300 candidates, 6 replayed stored v1 verdicts, all likely compatible;
  - analysis #2: Webb synthetic demo with prompt v2, 5 replayed: 2 potential contradictions, 2 compatible, 1 for review.

## Phase 4: integration, errors, performance (done)

**Integration.** `tests/db/workflow-api.test.ts` runs the real end to end: create a case, upload P3171 and P3173 with filenames, a duplicate upload returns the existing session, the worker parses both, a demo analysis runs (30 candidates, none invented), and the case is read back. Also tested: cases, analysis validation, the demo findings API with verbatim lines, and the live block plus resume.

**Error handling, and where each case is tested:**

| Case | Where tested |
| --- | --- |
| Invalid, empty or non-PDF upload | `api.test.ts`, `worker.test.ts` |
| Duplicate upload | e2e, `api.test.ts` |
| Missing witness | `api.test.ts` |
| Missing credentials (`blocked_credentials`) | `analysis.test.ts`, workflow |
| Exhausted budget (`blocked_budget`, then resume) | `analysis.test.ts` |
| Repeated call failures (`failed`; reservations counted as uncertain) | `analysis.test.ts` |
| Restart or redelivery (idempotent re-run) | `analysis.test.ts` |
| Missing pages (gap marking) | packet tests, UI |
| Invalid model response (stored, not retried) | `analysis.test.ts`, `adjudicate.test.ts` |
| Unsupported citation | `adjudicate.test.ts`, `synthetic.test.ts` |
| No contradictions (empty state) | Ellison demo, e2e |

Not covered by a test: the analysis dead-letter handler (it is guarded so it never overwrites a terminal status).

**Performance (local, Apple Silicon, dev DB):**
- parse P3171 (211 pages): 0.53 s; parse P3173: 0.04 s;
- Path A: 36 ms; Path B: 0.62 s; merge and select: 3 ms;
- Ellison demo analysis end to end (300 candidates): 2.3 s;
- API reads: 4–8 ms per HTTP call;
- live projection from the measured Sonnet calls (mean 4.8 s, about $0.0064 each): 300 pairs is about 25 minutes and about $1.93, one call at a time.

## Phase 5: polish and demo (done)

- **UI fixes:**
  - v1 global CSS scoped;
  - finding scrolls into view on narrow screens;
  - case finding counts now from the latest analysis (re-runs no longer double-count);
  - "findings in the latest analysis" wording.
- **`scripts/demo.ts`:** stores the fixture suites and starts or reuses demo analyses for Ellison (#3) and Webb (#4, prompt v2) through the API. In the dev DB, analyses #1 and #2 are earlier equivalents (left in place: no deletion).
- **Docs:** README (v2 setup, usage, demo, tests, limitations; v1 sections nested under Quick compare), CLAUDE.md, the DESIGN.md implementation notes, `.env.example` (`ALLOW_PAID_CALLS`).

**Final verification:**
- 470 tests pass (two consecutive full runs);
- `npm run typecheck` is clean;
- `npm run build --prefix client` passes.

**Known flaky:** `tests/db/worker.test.ts` failed once (5 tests, "Unexpected end of JSON input" from an upload response) in 1 of 3 full runs. It passes alone, alongside `workflow-api`, and in the next two full runs. Cause not found.

**Not done or open:**
- review-state editing (confirm or dismiss) in the UI;
- the analysis dead-letter test;
- the flaky worker test;
- claim tagging of new uploads (paid);
- choosing the default prompt (v1, v2 or v3) needs your approval, and v3 has not been run.

## Paid API calls this sprint

None. llm_calls stayed at 86 and model verdicts at 18.
