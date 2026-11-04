# Milestone 1 baseline (November 3, 2026)

The protected state Milestone 2 builds on. Every figure was measured on this machine. No paid model call was made. Rerun with the commands below. A different result means something changed and should be explained before work continues.

## Code

- Branch `multi-analysis`, baseline commit `b3acf61` (local only, never pushed). Milestone 1 adds migration 0034 and the documents listed in "Changes made in Milestone 1".
- Parser `pdfjs-ellison-doj-v1-r11` (`server/src/ingest/layout.ts`).
- Migrations: 0000 to 0033 at the baseline; Milestone 1 adds `0034_deposition_misfiled`, applied to the development database.
- Node 24.22 (`.nvmrc` 24). Postgres 16 with pgvector, in Docker (`docker-compose.yml`).

| Check | Command | Result | Time, peak memory |
|---|---|---|---|
| Unit and database tests | `npm test` (`TEST_DATABASE_URL` set) | 104 files, 1,169 tests passed, 0 failed (1,170 with the `misfiled` test) | 170 s one file at a time; 27 s after the test-workflow change below |
| Typecheck | `npm run typecheck` | passed | 1 s |
| Client build | `npm run build --prefix client` | passed | 2 s |
| Stage 1 real-data evaluation | `npx tsx scripts/evidence.ts eval-real` | 39 checks passed, 0 failed | 9 s, 0.56 GB |
| Stage 2 real-data evaluation | `npx tsx scripts/facts.ts eval-real` | 79 checks passed, 0 failed; 13 facts in the verified index | 6 s, 0.34 GB |
| Fresh clone, no database | `git clone`, `npm ci`, typecheck, `vitest run`, client build | all passed; 801 tests passed, 367 database tests skipped (no `TEST_DATABASE_URL`) | `npm ci` 4 s |

The real-data evaluations need the private fixture files under `data/raw/` (git-ignored). All of them were present. Without them, `eval-real` fails and names the missing file, and the Vitest copies skip and say so.

Stage 1 fixtures cover 6 documents, 16,323 lines and 5,935 exchanges (5,929 question/answer). Every exchange is indexed and every witness line belongs to an exchange.

## Retrieval (offline, frozen)

Both frozen corpora were re-evaluated with the round-2 inputs. Each new `report.json` is identical to the round-2 report apart from runtime: corpus 1 to `data/raw/retrieval/round2/lead/ladder/eval-c1/report.json`, corpus 2 to `eval-c2/report.json` in the same folder. All 33 files of the round-1 baseline manifest, and every file hashed in the `frozen-v1`, `frozen-v2` and `frozen-corpus2-v2` manifests, match their recorded SHA-256. Outputs: `data/raw/retrieval/m1-baseline/` (git-ignored).

```sh
R=data/raw/retrieval/round2
# corpus 1 (CASE='^hutchinson|^(?=simpson|resnick)', also --benchmark $R/agent-6/heldout-c1v2.json)
# corpus 2 (CASE='^([AB][0-9][0-9])_')
npx tsx scripts/retrieval-eval.ts --frozen $R/agent-6/<frozen-v2|frozen-corpus2-v2> \
  --paths <frozen>/minilm/neighbours-E_minilm_qac_s.json --paths <frozen>/minilm/rankings-E_minilm_qac_s.json \
  --paths $R/lead/ladder/<c1|c2>/neighbours-F_factual.json --paths $R/lead/ladder/<c1|c2>/rankings-F_factual.json \
  --no-frozen-pools --pools <frozen>/pools/pool-<c>v2-add-minilm.json --pools <frozen>/pools/pool-triaged-<c>v2-default.json \
  --pools $R/lead/ladder/<c>/pool-<c>v2-add-factual-reserve-F1.json --pools $R/lead/ladder/<c>/pool-triaged-<c>v2-combined.json \
  --group --case-pattern "$CASE" --out data/raw/retrieval/m1-baseline/eval-<c>
```

| Corpus | Items | Default pool (triaged) | Within one case | Targets held | Packets (within case) | Runtime, memory |
|---|---|---|---|---|---|---|
| 1 (Hutchinson, Simpson, Resnick) | 5,552 | 14,476 pairs | 13,692 pairs | 4 / 4 | 3,306 packets vs 13,691 listed pairs | 23 s, 3.4 GB |
| 2 (independent synthetic, 10 cases) | 529 | 1,561 pairs | 1,199 pairs | 21 / 23 (23 / 23 with `F_factual`) | 339 packets | 2 s, 0.59 GB |

With `F_factual`, the corpus 1 within-case pool holds 13,559 pairs and 3,320 packets, and still holds 4 of 4 targets. Packets hold at most 8 passages and 6,000 projected tokens. How well packets adjudicate is untested: that is Milestone 2.

## Development database

- 33 documents in 15 cases: 27 active, 6 excluded.
- 8,578 exchanges in active documents; 20 analyses, 1,265 findings, 10 reviewed.

Exclusions:

| Document | Reason | Since |
|---|---|---|
| 32, 33 | `legacy_parse` | Stage 1 |
| 60 | `duplicate` of 54 | Stage 1 |
| 61 | `duplicate` of 56 | Stage 1 |
| 58 | `misfiled` | Milestone 1 |
| 64 | `misfiled` | Milestone 1 |

The Hutchinson case (16) counts two active documents, 54 and 56.

## Changes made in Milestone 1

- **Documents 58 and 64.** Both were stored in the Cassidy Hutchinson case.
  - 58 is the synthetic Marcus Webb text ("Deposition of Marcus Webb — March 14, 2023", 13 lines). It was pasted under witness Cassidy Hutchinson.
  - 64 is `gates8a.pdf`, pages 497–498 of Bill Gates's Microsoft deposition, under a witness named "Gates".
  - Neither had analyses, candidates, findings, claims, cards, facts, fact units or discovery references.
  - The existing reasons were wrong for these documents (`legacy_parse` and `duplicate` would misstate the cause), so Milestone 1 adds `misfiled`:
    - migration 0034 widens the check constraint;
    - `excludeDocument()`, `scripts/evidence.ts exclude --reason misfiled` and the parser audit accept it;
    - one test in `tests/db/exclusion.test.ts` covers it.
  - Both documents were excluded with the existing command. Every line, exchange, analysis, finding and review count is unchanged before and after.
  - Backups: `data/raw/backups/m1-docs-58-64-before.json`, `m1-counts-before.json` and `m1-counts-after.json`.
  - To undo: `update depositions set excluded_reason = null where id in (58, 64)`.
- **Agent instructions.** `CLAUDE.md` went from 32,376 to about 9,700 bytes. The repository map and the command list moved verbatim to `docs/architecture.md` and `docs/commands.md`, which Claude and Codex share. `AGENTS.md` was a stale copy of an older `CLAUDE.md` (14,864 bytes, still describing v1 and files since removed); it became a short Codex brief, and was removed later on November 3 when development moved to Claude Code only (the task contract now lives in `CLAUDE.md`, "Agents", and `.claude/agents/`).
- **Graphify.**
  - A code-only, local graph (`.graphifyignore`), git-ignored together with `.claude/worktrees/`.
  - `graphify update .` rebuilds it in about 3 seconds. It passes with network access denied by `sandbox-exec`, and its indexing modules load no network library.

## Test workflow (Milestone 1)

Measured on 14 cores, Postgres in Docker. The 170 s run was one file at a time because every database test file shared one database. Per-file durations added up to only 125 s (87 s database, 38 s other); the remaining 45 s was startup paid serially.

| Configuration | Full suite | Result |
|---|---|---|
| Before: `fileParallelism: false` | 170 s | 1,169 passed |
| Parallel, one database per worker, 4 workers | 44 s | 1,170 passed |
| The same with 8 workers | 29 s | 1,170 passed |
| The same with 13 workers (default) | 26 to 29 s over 8 consecutive runs | 1,170 passed, 0 skipped, 0 failed every run |
| `test:fast` / `test:integration` on a change to `retrieve/grouping.ts` | 0.6 s / none to run | 1 unit file |
| The same on a change to `evidence/store.ts` | 0.7 s / 16 s | 2 unit and 6 integration files |

Changes:

- **Two Vitest projects.** `unit` and `integration` both run in parallel.
- **One database per worker.** `tests/db/workerDatabase.mts` gives each Vitest worker its own database. Every file still drops and re-migrates it, so isolation is unchanged.
- **Concurrent OCR reads.** The five real Gates OCR reads run concurrently (33 s down to 20 s); each already uses its own temporary folder.
- **A 20 s integration timeout.** `evidenceReal`'s re-read took 4.5 s even run alone and failed the 5 s default under load. Unit tests keep 5 s.
- **A test race fixed.** One `workflow-api` test raced the live pg-boss worker: it set an analysis's status while the worker could still write its own. The test now waits for the analysis to complete first. Its assertions are unchanged.

No test was disabled and no assertion changed.

Remaining floor: about 20 s each for `execution.test.ts` (mock requests under real concurrency and retry timing), `worker.test.ts` (real retry backoff), `workflow-api.test.ts` and `extract.test.ts` (end to end), and the 60-page `gates8b.pdf` OCR read.

## Navigation experiment (graph vs ordinary search)

Measured as tool calls and characters returned to the agent (about 4 characters per token).

| Task | Ordinary search | Graphify | Correct? |
|---|---|---|---|
| Data path from ingestion through evidence exchanges to retrieval | 3 `grep` calls, about 2,150 characters | 5 calls (2 failed: directed paths by default), about 7,200 characters | Search: yes. It showed that `ingest/rows.ts` writes `evidenceFieldsOf()` from `evidence/exchange.ts` into the `exchanges` table, and that retrieval reads stored rows (`claims/facts` `loadDocument`, `evidence/eligibility`) rather than importing ingestion. Graph: no. Its shortest paths ran through barrel `index.ts` re-exports (`rows.ts → verify/index.ts ← independent.ts`), not the real data flow, and its query output was truncated noise. |
| Every caller of `excludeDocument()` | 1 `grep`, about 2,350 characters, all 3 calling files | 1 query, about 400 characters | Search: yes. Graph: no, it found the definition but none of the callers (calls through the barrel `evidence/index.ts` aren't resolved). |

Conclusion: no token saving was measured, and on both tasks the graph's answer was wrong or incomplete. It is kept as an optional aid for locating where a symbol is defined, never as a required first step. `CLAUDE.md` says so.

The graphify `PreToolUse` hook in `.claude/settings.json` (local, untracked) adds a "use graphify query" note to every Bash, Grep, Read and Glob call. That was 13 injections in this session. It is small but always on. Removing it is recommended (`graphify claude uninstall` removes the hook and the section it wrote); that is the developer's decision.
