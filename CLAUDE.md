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

## Repository structure

**Existing:**
- `server/src/index.ts`: Express app with the case, analysis, finding and deposition endpoints from `api/` when Postgres is reachable
- `server/src/worker.ts`: the ingest worker process
- `server/src/api/`: v2 endpoints: cases and witnesses (`cases.ts`); upload a deposition, read its status, retry, set its date (`PATCH`), and move it to another witness or case by re-reading its stored file (`depositions.ts`); start, read and resume analyses, and grouped findings and one finding with both passages (`analyses.ts`); finding sections and labels (`present.ts`, pure)
- `server/src/jobs/`: pg-boss queues; the ingest job handlers; the analysis job (`analysis.ts`: wait for parsing, retrieve, adjudicate in demo or live mode under a budget, record progress); `paidCallsAllowed` gates live calls
- `server/src/adjudicate/`: demo replay of stored or fixture verdicts (`replay.ts`, never calls a model); evidence packets from stored lines (`packet.ts`), the strict `Verdict` schema, the Sonnet prompt and client (`model.ts`, the only file here that calls the API), `assess()` (Layer 1, Layer 2, checks, score, priority; pure), candidate persistence, and `adjudicateCandidate()` (reserve, call, record, settle, store verdict and finding); execution strategies (`strategies.ts`, `pool.ts`, `execute.ts`; the default is C, ten independent single-pair requests with `adjudicate-v3`), and the request record (`requests.ts`)
- `server/src/adjudicate/discover.ts`: direct discovery: the provider (one of two files here that call the API), the restart-safe attempt state in `discovery_runs`, the refusal fallback and finding persistence. `discoverPrompt.ts` holds the frozen prompt, `discoverSchema.ts` its strict output
- `server/src/adjudicate/discoverCross.ts`: cross-witness discovery (one session each of two witnesses, chosen like a same-witness pair; Opus 5.5, with Fable after a refusal): session loading, the prompt (`discoverCrossPrompt.ts`, `discover-cross-v2`) and schema (`discoverCrossSchema.ts`), and finding storage; `discover.ts` runs both kinds through `flavorOf()`. `analyses.kind` and `witness_b_id` mark it; `verify/cross.ts` checks its findings and `score/evidenceStrengthCross.ts` scores them
- `server/src/evidence/`: the Stage 1 evidence foundation (no model calls): references in each transcript's own scheme (`references.ts`), an exchange's stable key, text hash and speaker status (`exchange.ts`, pure, also used by ingestion), and the original-testimony index with retrieval, context, coverage and indexing (`store.ts`). Sessions are `deposition_sessions`; a deposition row is one file, with `session_id` and `session_part`. `server/src/eval/storedExport.ts` reads a stored deposition exported for the real fixtures (`data/eval/evidence-fixtures-v1.json`); `audit.ts` reports attribution causes, parser-revision artifacts and re-reads a stored document in place; `server/src/eval/evidenceFixtures.ts` holds the real-data checks. `server/src/ingest/segments.ts` finds speaker changes inside an archive statement, stored in `line_segments`
- `server/src/verify/direct.ts`: pure verification, lanes and deduplication for direct findings
- `server/src/score/evidenceStrength.ts`: the `evidence-strength-v1` checklist for direct findings (pure)
- `server/src/eval/directBenchmark.ts`: scores a direct analysis against synthetic labels by source lines
- `server/src/verify/`: v1's quote matching (`quotes.ts`, moved unchanged), `readAnswer`, shared text helpers, Layer 1 source verification (`source.ts`) and Layer 2 attribution (`attribution.ts`)
- `server/src/score/`: the frozen `RUBRIC_V1`, code's corroboration, context and time checks, `score()` and `prioritize()`
- `server/src/claims/facts/`: Stage 2 fact and event extraction: answer-group units from stored Stage 1 rows with speaker segments as spans (`context.ts`), the model contract and dimension rules (`contracts.ts`), the prompt, batching and estimate (`prompt.ts`), code's source and attribution checks (`verify.ts`, pure), unit coverage, staleness and the Stage 3 read interface `verifiedFacts()` (`store.ts`), `extractFacts()` (`extract.ts`) and `factCoverage()` (`coverage.ts`); the Haiku client is `anthropicFactModel` in `claims/model.ts`. `server/src/eval/factFixtures.ts` runs the hand-authored records of `data/eval/facts-expected-v1.json`
- `server/src/claims/`: Path A input: statement cards (`cardPrompt.ts`: prompt and page chunking; `cards.ts`: code's checks; `extract.ts`: `extractCards()`, coverage, `cardSummary()`), the topic map (`topicMap.ts`: prompt, response reading, report, pure; `topics.ts`: `buildTopicMap()`), the Haiku clients (`model.ts`, the only file here that calls the API), shared entity grounding (`verify.ts`, `entities.ts`) and the yes/no answer reader
- `server/src/retrieve/`: hybrid retrieval: Path A from cards (`topicPairs.ts`: topic and entity links, signals, exclusions, ranking) and the union with its 60/40 allocation (`union.ts`, pure); Path B full-text retrieval (`pathB.ts`), the procedural filter and courtroom word list (`procedural.ts`), query terms by mode (`query.ts`), the symmetric pair score (`score.ts`), and logical-exchange dedupe and ranking (`rank.ts`)
- `server/src/eval/`: the evaluation label file format (`labels.ts`); labels live in `data/eval/*.json`, anchored by PDF SHA-256 and page:line; `synthetic.ts` / `syntheticStore.ts` build the labelled synthetic Webb adjudication cases from `data/samples.ts`
- `server/src/eval/discovery.ts`, `mockCards.ts`: end-to-end discovery: labelled exchanges among fair distractors, found by real retrieval, scored afterwards; rule-based card and topic models that read only what a model would be sent (they measure the pipeline, never Haiku)
- `server/src/costs/`: model price table (`pricing.ts`), the models v2 calls per stage (`models.ts`), the pure `callCost()`, and `recordCall()` / `jobCost()` over `llm_calls`; `budget.ts` keeps stored budgets and reserves each call's worst-case cost atomically before it is sent
- `server/src/timing.ts`: optional stage timings for benchmarks, written to `BENCHMARK_TIMING_FILE` only when it is set
- `server/src/transcript.ts`: `Q:`/`A:` parser (replaced in v2)
- `server/src/ambiguity.ts`: time-range comparison, reused as-is in v2
- `server/src/data/samples.ts`: Marcus Webb and Elena Ruiz samples, kept as synthetic fixtures
- `tests/`: Vitest tests for the pure functions above
- `scripts/pathb.ts`: previews Path B's ranked candidate pairs with both passages, for labelling
- `scripts/ingest.ts`: ingests one deposition PDF into Postgres from the CLI (development only); `scripts/cases.ts` finds or creates its case and witness by name
- `client/src/`: Veridict, the v2 app. A navy icon rail that opens over the page on hover or keyboard focus, like the Dock (`components/Shell.tsx`, which also opens `components/AddDeposition.tsx` from any page: several files of any supported type in one drop zone, sharing case and witness, or pasted text) leads to Overview, Cases, Depositions, Findings, Analyses and Help; each list has its single screen (`pages/CasePage.tsx`, `DepositionPage.tsx` with the transcript reader and search, `AnalysisPage.tsx`: a sticky findings bar (`components/FindingRegister.tsx`: category tabs and a searchable finding switcher) above the full-width `components/FindingPanel.tsx`). Testimony is drawn by `components/FindingView.tsx` as a transcript sheet. Hash routes in `lib/router.ts`; cross-case lists come from `lib/workspace.ts` (one request per case, a marked shortcut); `lib/insights.ts` holds pure derived figures, including `displayRef`; `lib/review.ts` labels decisions, saved with `PATCH /findings/:id/review`; `lib/labels.ts` holds plain-language wording; `lib/api.ts` the client. Product brief in `PRODUCT.md`.
- `server/src/auth.ts`: public registration with email verification, sign-in, forgot and reset password (scrypt passwords; session and one-time link tokens stored only as hashes), the same-origin check, per-account scoping of every case, deposition, analysis and finding ID, and the gates on uploading (verified email) and paid checks (`users.analysis_access`, granted by `npm run admin`). `server/src/email.ts` sends through Resend (`RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`), printing to the console in development when unset. The public landing page is `client/src/pages/LandingPage.tsx` with its scroll scenes in `landing.css`; its pictures are real app screenshots in `client/public/landing/`. `server/src/api/remove.ts` deletes depositions and cases with everything that depends on them. `server/src/index.ts` serves the built client from `client/dist` in production; see `docs/deploy.md`, `Dockerfile` and `compose.prod.yml`.
- `server/src/ingest/`: v2 ingestion (`text.ts` reads .txt and pasted text: numbered text keeps its page:line, unnumbered text is stored on page 0 and cited by line, and `verify/direct.ts` holds its findings at needs context): extraction, per-page validation against the `ellison-doj-v1` layout, speakers, exchanges and long-answer parts (pure functions); `rows.ts` maps them to database rows, `store.ts` saves a deposition in one transaction, `uploads.ts` keeps PDFs under `data/uploads/` by SHA-256, and `ingestFile` in `index.ts` runs all three; `ocr.ts` reads scanned files locally with Tesseract into the same page extraction; `pdfText.ts` reads a born-digital PDF with printed line numbers in another layout from its own text; `sessionDate.ts` finds the session date on the cover, offered to the user to confirm (a check needs both dates); `physical.ts` reads a text PDF with no line-number gutter by physical line (layout `pdf-physical-v1`, checked with `hasPhysicalLines`), whose references are labelled as not official and held at needs context
- `server/src/db/`: Drizzle schema (`schema.ts`) and connection (`client.ts`); migrations generated into `drizzle/`
- `docker-compose.yml`, `docker/postgres-init/`: local Postgres, plus a separate `deposition_checker_test` database for the test suite
- `scripts/spike/`: `download.sh` fetches the source PDFs, and `html.ts`, `pdf.ts`, `exchanges.ts` are the independent readers `tests/ingest/real-documents.test.ts` checks ingestion against; production code lives in `server/src/ingest/`
- `docs/agent-log.md`: log of agent sessions

**Planned v2 modules** (folders under `server/src/`, each with one public entry point; see `DESIGN.md`, Modules section): `ingest/`, `claims/`, `retrieve/`, `adjudicate/`, `verify/`, `score/`, `costs/`, `jobs/`, `api/`, `eval/`. Only `claims/` and `adjudicate/` may call a model, and every such call goes through `costs/`.

## Development commands

- `npm install`: installs root deps; `postinstall` also installs `client/` deps
- `npm run dev`: server (`tsx watch`, port 3001), ingest worker and Vite client (port 5173, proxies `/api` to 3001)
- `npm run worker`: the worker on its own (ingest and analysis jobs; needs Postgres)
- `npx tsx scripts/eval-review.ts build|import`: builds the human review set (tracked references in `data/eval/review-set-v1.json`, testimony in the git-ignored sheet `data/eval/review/review-set-v1.csv`), or copies the filled-in sheet back; no API call. Retrieval code must never read this set
- `npx tsx scripts/interrupt-analysis.ts --analysis <id>`: closes out an analysis whose worker is gone, counting any open request in full; no API call
- `npx tsx scripts/demo.ts [--fresh]`: with `npm run dev` running, stores the synthetic fixture cases and starts demo analyses (Ellison, Webb) through the API; no model calls
- `npm test`: all Vitest tests in `tests/`
- `npx vitest run tests/verify.test.ts`: one test file
- `npx vitest run -t "<test name>"`: one test
- `npm run typecheck`: `tsc --noEmit` over `server/`, `scripts/` and `tests/` (not the client)
- `npm run build --prefix client`: typechecks and builds the client
- `npm run db:up` / `npm run db:down`: start or stop Postgres in Docker
- `npm run db:generate`: write a new SQL migration to `drizzle/` after changing `server/src/db/schema.ts` (review the SQL, then commit it)
- `npm run db:migrate`: apply migrations to the database in `DATABASE_URL`
- `npx tsx scripts/ingest.ts <file.pdf> --case <name> --witness <name> [--taken-on YYYY-MM-DD]`: ingest one PDF into the database in `DATABASE_URL`; re-running it on the same file replaces that deposition's rows instead of duplicating them
- `npx tsx scripts/pathb.ts (--case-id <id> | --case <name>) --witness <name> [--deposition <id>] [--mode all_terms|rare_terms] [--limit 15] [--lines 8]`: preview Path B pairs from the database in `DATABASE_URL` (read-only); a case name must match exactly one case and witness, and `--deposition` must be a ready deposition of that witness
- `npx tsx scripts/hybrid.ts estimate|report|pool (--case-id <id> | --case <name>) --witness <name> [--deposition <id>] [--a <id> --b <id>]`: card cost estimate, stored coverage and topic report, or both paths and the union as counts; no API call. `discovery [--distractors 60] [--capacity 30] [--mode rare_terms|all_terms]`: the synthetic discovery evaluation with mock models (wipes `TEST_DATABASE_URL`); no API call. `cards … --deposition <id> --budget-name <n> --budget-limit <usd> [--max-chunks 2]` and `topics … --budget-name <n> --budget-limit <usd>` make paid Haiku calls: run them only with approval
- `npx tsx scripts/direct-benchmark.ts estimate`: the synthetic evaluation's plan and cost, no API call. `score --analysis <id> --suite whitfield|webb` scores a finished analysis, no API call. `run --execute --approved-usd <n>` makes paid Fable batch calls on synthetic testimony: run it only with approval
- `npx tsx scripts/cross-benchmark.ts estimate --set data/eval/<set>-cross-v1.json --root <documents dir>`: the cross-witness evaluation's sessions, label resolution and cost range for Fable, Opus and Sonnet; no API call. `score --report <file> --root <dir>` re-scores a saved run, no API call. `run … --model fable|opus|sonnet --approved-usd <n> --execute` makes one paid batch call per comparison: run it only with approval. Reports (they quote testimony) go to the git-ignored `data/eval/review/cross/`
- `npx tsx scripts/direct-model.ts stored --analysis <id> [--labels data/eval/hutchinson-discrepancies-v1.json]`: re-checks an analysis's stored direct answer and, with `--labels`, scores labelled discrepancies for discovery and classification separately; no API call. `score --report <file> --labels <file>` scores a saved report, no API call. `run --analysis <id> --model opus|fable --approved-usd <n> --execute` makes one paid batch call on that analysis's sessions without changing the analysis (needs `ALLOW_PAID_CALLS=true` on that command): run it only with approval. Reports go to the git-ignored `data/eval/review/direct-model/`
- `npx tsx scripts/evidence.ts index [--case-id <id>] [--refresh]`: fills (or recomputes) the evidence fields of stored exchanges; `coverage --case-id <id>`, `search <words> --case-id <id> [--witness-id|--session-id|--document-id <id>]`, `get <exchange id> [--case-id <id>]` and `context <exchange id> [--lines 5]` read the index; `export-lines --deposition <id> --out data/raw/fixtures/<name>.json` saves a stored file for the real-fixture tests; `attribution --document-id <id>` explains non-verified exchanges; `parser-audit` lists stored documents with artifacts a later parser fixed (read-only); `reprocess --document-id <id> [--execute] [--accept-impact]` re-reads one in place (a dry run unless `--execute`; refuses to remove findings unless `--accept-impact`); `correct --document-id <id> [--execute] [--out data/raw/<file>.json]` corrects one in place when only speaker attribution changes, keeping every line ID and every referenced exchange ID (a dry run unless `--execute`, which first writes a backup under `data/raw/backups/`; refuses, changing nothing, when text changes or a referenced exchange would change its lines, and then maps it to the corrected exchanges); `exclude --document-id <id> --reason legacy_parse|duplicate [--duplicate-of <id>]` leaves a stored copy out of new analyses, retrieval and the evidence index, keeping it and its findings (a duplicate names the active copy of the same file in the case); `eval-real` runs the real-data evaluation in `TEST_DATABASE_URL` (wipes it) and fails if a fixture file is missing or a check fails. No API calls. `scripts/ingest.ts … --session-of <deposition id>` stores a file as the next part of that deposition's session
- `npx tsx scripts/facts.ts plan --case-id <id>`: units, due units, requests, tokens and planned cost of Stage 2 extraction for a case's active documents; no API call, no writes. `coverage --case-id <id>`: units by status, facts indexed, rejected and stale, measured tokens and cost. `eval-real`: the hand-authored fact records through the real pipeline in `TEST_DATABASE_URL` (wipes it), no API call, fails if a fixture file is missing or a check fails. `run --document-id <id> --approved-usd <n> --execute` makes paid Haiku calls (needs `ALLOW_PAID_CALLS=true`): run it only with approval
- `npx tsx scripts/retrieval-embed.ts embed|score [--frozen data/raw/retrieval/frozen-v1] [--out data/raw/retrieval/agent-a] [--reps qac,qc,a] [--strip] [--center]`: local MiniLM embeddings (`@huggingface/transformers`; model and revision pinned in `server/src/retrieve/minilm.ts`, read from the git-ignored `data/raw/models/` with remote loading off; the script header shows the one-time download) as a retrieval path over a frozen benchmark. `embed` writes `neighbours-E_minilm_<rep>[_s][_c].json` and `rankings-…json` with an on-disk vector cache; `score` prints every path's per-query ranks of the labelled pairs and the fused top-5 pools. No API call
- `npx tsx scripts/facts-pilot.ts plan|report [--set data/eval/facts-pilot-v<n>.json]`: a real-model Stage 2 pilot's windows, units, requests and planned cost, or its report (recall candidates, compatibility, source validity, repeatability; testimony, so written to git-ignored `data/raw/`); no API call. `run --set <file> --approved-usd <limit> --execute` makes paid Haiku calls under the pilot's budget (needs `ALLOW_PAID_CALLS=true`): run it only with approval
- `npx tsx scripts/retrieval-probe.ts [--facts] [--json]`: the independent retrieval feasibility probe over every real fixture document in `TEST_DATABASE_URL` (wipes it): full text, LSA, question-centered and anchor paths, fused, with the known pairs' global and per-query ranks and per-item candidate budgets; `--facts` adds the pilots' indexed facts from `DATABASE_URL` as a fifth signal; no API call. Reports go to git-ignored `data/raw/retrieval/`
- `npx tsx scripts/retrieval-eval.ts --frozen <dir> [--paths <file>...] [--pools <file>...] [--benchmark <file>...] [--no-frozen-pools] [--out <dir under data/raw>] [--json]`: the independent retrieval evaluator over a frozen corpus (`server/src/retrieve/frozen.ts`) and any extra path or pool files: integrity checks, each labelled pair's rank in both directions per path, fused and with each path removed, pool holdings and budgets, path contribution, an unlabelled sample (to `--out` only), runtime and memory; controls and exploratory pairs reported apart, counts only. `--build-heldout <cross labels> --frozen <dir> --write <file>` resolves line labels to a corpus's items (`data/eval/simpson-resnick-heldout-v1.json`); `--build-fixture <cross labels> --root <dir> --write <file>` turns phrase labels into an evidence fixture for `scripts/retrieval-freeze.ts` (`data/eval/independent-cross-v1-fixture.json`). No database, model or API call
- `npx tsx scripts/retrieval-triage.ts --variant <name> [--frozen <dir>] [--pool <file>] [--max-pairs <n>] [--out <dir under data/raw>]`: triages a candidate pool (`server/src/retrieve/triage.ts`; defaults measured on both corpora: no rare-word gate, two partner passages per item, no budget) and writes the kept pool and every deferral with its stage and reason; no API call
- `npx tsx scripts/retrieval-pools.ts --frozen <dir> --name <n> --out <dir under data/raw> [--extra <neighbours file>...] [--drop <path>...] [--per-item 5]`: builds a fused candidate pool from a frozen corpus's paths plus extra ones (e.g. MiniLM); `npx tsx scripts/retrieval-triage-sweep.ts` measures triage variants on both corpora's five-path pools; no API call
- `npx tsx scripts/rescore-direct.ts --analysis <id> [--write]`: scores stored direct findings with the evidence-strength checklist; no API call
- `npx tsx scripts/adjudicate.ts fixtures|list|show|estimate …`: store the synthetic Webb evaluation (`webb-synthetic-v1`), list candidates, print a packet with its verdicts and findings, or estimate worst-case and measured expected cost; no API call. `run --candidate <id> --budget-name <n> --budget-limit <usd> [--effort medium] [--prompt adjudicate-v1|adjudicate-v2]` makes one paid Sonnet call: run it only with approval
- Database tests in `tests/db/` run only when `TEST_DATABASE_URL` is set (they wipe that database, whose name must end in `_test`); otherwise they are skipped. They share one database, so `vitest.config.mts` runs test files one at a time

Requires a `.env` with `ANTHROPIC_API_KEY`, `DATABASE_URL` and `TEST_DATABASE_URL`. Live analyses call a model only when `ALLOW_PAID_CALLS=true` is also set; leave it unset in development and tests. See `.env.example`, whose database URLs match `docker-compose.yml`. Add new commands here only once they exist and work.

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
