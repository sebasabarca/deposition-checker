# Multi-model contradiction discovery experiment

An independent experiment asking whether direct model reasoning finds contradictions our hybrid retrieval pipeline loses, and whether any gain justifies its cost and complexity. It changes nothing in production. **No external model call has been made.** Provider facts were checked on October 31, 2026; recheck them before running.

## Commands

Run from the repo root. Everything here is local unless `--execute` passes the gate.

| Command | What it does |
| --- | --- |
| `npx tsx experiments/multimodel-contradictions/src/cli.ts prepare` | Builds datasets, pair packets and synthetic targets in `work/` from Postgres and the fixtures |
| `… schemas` | Writes `schemas/run-output.schema.json` |
| `… estimates` | Local token, fit and cost table |
| `… run --arm A\|B\|C --experiment discovery\|pairs --dataset ellison\|webb\|whitfield\|synthetic\|real` | Dry run: writes the plan and the exact first prompt to `work/dry-run/` |
| `… armd [--analysis 12]` | Copies arm D's stored results to `work/`; no call |
| `… compare` | Verifies citations, compares arms, writes `review/comparison.json` and `review/proposed-contradictions.csv` |
| `… subject [--terms a,b]` | Exports keyword-matched lines to `review/subject-review.csv` for manual review |

`work/`, `runs/`, `review/` and `config/approval.local.json` are git-ignored because they hold testimony or local approvals.

## The gate

A call happens only when all of these hold. Any missing one writes a dry run instead.

1. `--execute` is passed.
2. `EXPERIMENT_ALLOW_EXTERNAL=true` is set for that command.
3. `config/approval.local.json` allows it, with this shape:
   ```json
   { "approvedBy": "", "approvedOn": "", "allowExternalCalls": true, "syntheticOnly": true, "realTranscriptAuthorized": false, "arms": { "C": { "maxCalls": 18, "maxUsd": 1.5 } } }
   ```
4. Real testimony also needs `syntheticOnly: false` and `realTranscriptAuthorized: true`.
5. The planned calls and worst-case cost are within the arm's limits, and the input fits. Nothing is ever truncated.

Each job gets one attempt: no retries, no fallback model. A paid arm stops before any call whose worst case could cross its cap.

## Arms

| Arm | Provider and model | Prompt control | JSON | Notes |
| --- | --- | --- | --- | --- |
| A | OpenCode `opencode/deepseek-v4.1-flash-free` | Agent prompt; may be added to OpenCode's own | Validated afterward | CLI required. Build not stated |
| B | DeepSeek API `deepseek-flash` (V4.1-Flash-1017) | Full | JSON mode, validated afterward | Thinking on by default |
| C | Anthropic `claude-sonnet-5-5`, effort medium | Full | Enforced, and validated | Streaming, adaptive thinking |
| D | Hybrid pipeline: stored results | Not applicable | Not applicable | Never re-run here |

A and B must not be treated as one model. Differences that can't be removed: temperature is left unset everywhere (Sonnet 5.5 rejects non-default values), thinking differs by provider, and arm A runs through a coding agent. Each run's manifest records model, parameters, prompt and schema hashes, git commit, and any model name the provider reports.

## Experiment 1: discovery

Each arm receives both complete sessions and nothing else: no candidates, cards, topics, classifications, labels or findings. `src/data.ts` builds the prompt only from transcript lines, and a test rejects any of those strings appearing in it.

Fitting in context doesn't prove coverage. One pass reading 94,000 tokens may skip testimony while reporting `complete`, so a single-pass result is never reported as full coverage. If single-pass results look promising but incomplete, a hierarchical pass is a separate experiment with a different architecture, labelled as such; it isn't built.

## Experiment 2: fixed pairs

All arms receive the same 40 packets: both passages with 5 context lines each side. The review set is used only to locate passages; labels and verdicts never enter a packet. Each arm returns its own classification and a separate comparability judgment.

## Verification

`src/verify.ts` checks every finding against parsed lines: witness, session pairing, page:line, exact or approximate excerpt, whether the words are elsewhere in the session, and who spoke. Unsupported findings stay in the results with their status. Whether a passage really supports a proposition is a human decision; code reports only word overlap.

## Evaluation

- **Synthetic discovery:** `work/synthetic-targets.json` holds 7 known contradictions (3 Webb, 4 Whitfield) among 60 fair distractors per session. Only the evaluator reads it. Reported separately from real testimony.
- **Real discovery:** no recall claim is possible from retrieved pairs. Choose a bounded subject, for example PeopleSoft pricing, run `subject`, read the surrounding pages, and record contradictions in `review/human-contradictions.json` before seeing model findings. That set is chosen by keyword and a person, not by retrieval.
- **Model findings:** review `review/proposed-contradictions.csv` by filling `human_decision`. Model findings and human decisions stay in separate columns and files.
- **Pair accuracy:** `pairAccuracy` needs `review/human-labels.json` with a named reviewer on each row, and refuses any row marked AI-proposed. Without it, only agreement is reported. The 40 AI-proposed labels are never ground truth.
- **Metrics:** recovered targets, verified, unique and shared findings, agreement, citation status, false positives after review, tokens, cache, cost, runtime, calls and failures.

## Before the first call

- Arm A: install OpenCode and sign in. Confirm with a synthetic prompt whether the agent prompt replaces OpenCode's own, that no tool runs, and that `parseOpencodeEvents` matches real output. It is written from the documentation, not tested against the CLI.
- Arm B: create a DeepSeek account and set `DEEPSEEK_API_KEY`. Its adapter is also untested against the live API.
- Arm D on synthetic data needs its own approved run of the existing pipeline; the fixtures have no cards.

## Event path (arms E1, E2)

Indexes each session's events with Haiku, aligns them across sessions, then has Sonnet compare one event at a time, detail by detail. Run the stages in order; each one without `--execute` prints its estimate and makes no call.

| Command | What it does |
|---|---|
| `… events --dataset <id> --stage map\|align\|compare [--execute]` | One stage. `map` and `align` write to `work/events/<id>/`; `compare` writes to `runs/` |
| `… events-mock` | Free plumbing check on the synthetic sets with rule-based stand-ins. It says nothing about model quality |

Stages use the same gate as the other arms, under the experiment names `events-map`, `events-align` and `events-compare`. Alignment favours inclusion, because the comparison discards wrong matches. Coverage, rejected spans, one-sided events and ids left out are reported, never dropped.

## Arm S: OpenAI GPT-6.1 Sol

Needs `OPENAI_API_KEY` in `.env`. It sends the same prompt as arm F, at `xhigh` effort with `store: false`, through a one-attempt streaming call. Reasoning summaries are not requested, so unlike arm F its reasoning can't be read.
