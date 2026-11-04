# Milestone 2 handoff: packet versus pairwise adjudication

**Objective.** Measure whether adjudicating an issue packet (up to 8 passages, one call) classifies labelled pairs as well as adjudicating each pair alone, and at what cost per correct finding. Code verifies every citation in both arms. The first runs are offline, with mock models. Paid runs happen only after the developer approves a USD limit (the pilot is about 60 packets, well under $1).

**What it does not include.** It doesn't change the default analysis method, the UI or retrieval.

## What exists (reuse, don't rebuild)

| Need                                        | Existing code                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairwise packet from stored lines           | `adjudicate/packet.ts`: `Packet` (one candidate: sides `a` and `b`), `loadPacket()`, `formatPacket()`, `evidenceOf()`, `CONTEXT_LINES`                                                                                                                                                 |
| Pairwise model client                       | `adjudicate/model.ts`: `Adjudicator` (`adjudicate(packetText, options)` returns `AdjudicatorReply`), `anthropicAdjudicator()`. Prompts are in `prompt.ts` (`adjudicate-v1` to `v4`, default `v3`), strict schemas in `schema.ts` (`Verdict` to `VerdictV4`, no score keys)             |
| Execution and accounting                    | `execute.ts` (`executeAdjudication`), `strategies.ts` (default C: ten single-pair requests), `pool.ts` (`runPool`), `requests.ts` (open, close, classify failures), `costs/budget.ts` (`reserve`, `settle`, `closeFailed`, `maxRequestCost`), `costs/` `recordCall()` and `callCost()` |
| Layer 1/2 checks and scoring                | `verify/source.ts` (`checkSources`, `locatePhrase`), `verify/attribution.ts` (`checkAttribution`), `adjudicate/assess.ts` (`assess()`), `score/` (rubric, `score()`, `prioritize()`)                                                                                                   |
| Citation checks for model-proposed findings | `verify/direct.ts`: `parseCitation`, `checkDirectSide`, `verifyDirectFinding`, `laneOf`, `groupDuplicates`, the pattern for verifying several proposals in one reply                                                                                                                   |
| Issue packets (offline contract)            | `retrieve/grouping.ts`: `EvidencePacket { id, issue, items, pairs, inputTokens }`, `PacketSet` (with `uncovered` pairs and reasons), `groupPool()`, `DEFAULT_GROUPING` (8 items, 6,000 tokens), `pairwiseWorkload()`, `coPacketed()`                                                   |
| Frozen corpora and labels                   | `retrieve/frozen.ts` (`FrozenItem`, `FrozenPair`, `CandidatePool`); the corpora in `data/raw/retrieval/round2/agent-6/frozen-v2` and `frozen-corpus2-v2`, plus `heldout-c1v2.json`. Commands are in `docs/baseline-m1.md`                                                              |
| Labels                                      | `data/eval/hutchinson-discrepancies-v1.json`, `data/eval/independent-cross-v1/` (sealed synthetic transcripts and labels), `data/eval/simpson-resnick-heldout-v1.json`, the synthetic Webb set (`eval/synthetic.ts`)                                                                   |
| Mock models (no API)                        | `eval/mockModel.ts` (`mockSingle`, timing assumptions), `eval/mockCards.ts`                                                                                                                                                                                                            |
| Model comparison runs                       | `adjudicate/compareModels.ts` (`paidRunCap`), `scripts/direct-model.ts`, `scripts/cross-benchmark.ts` (estimate, run with `--approved-usd`, score saved reports)                                                                                                                       |

## What is missing

1. **A packet prompt and strict schema.** One verdict per listed pair in the packet, keyed by pair ID, with exchange citations. It reuses `Verdict` fields with no score, confidence or probability keys. Each new version goes in `prompt.ts` and `schema.ts`.
2. **A packet loader from stored lines.** It maps a frozen item key (`document#first-last`) to stored exchange and line IDs, so every quoted line comes from the database, never from frozen JSON or model output.
3. **Packet reply verification.** Every pair in the packet gets exactly one verdict; a missing or extra pair is counted, never dropped. Citations are checked with `verify/` before any scoring.
4. **An evaluation harness.** Pairwise and packet arms run over the same labelled pairs plus a fair sample of unlabelled pool pairs. It scores recall on targets, false positives on controls, agreement between the arms, verified-citation rate, and measured tokens and cost per arm. It runs first with a mock adjudicator (no API), then on the approved paid pilot.
5. **A cost estimate** from `costs/` for both arms before any paid run.

## Proposed assignments

| Task                                     | Agent                                        | Allowed files                                                       | Acceptance                                                                                                  |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A. Packet schema and prompt              | Claude: wording decides adjudication quality | `adjudicate/prompt.ts`, `adjudicate/schema.ts`, tests               | Strict schema rejects score-like keys; prompt versioned                                                     |
| B. Frozen-item to stored-line loader     | Codex                                        | new `adjudicate/packetLoad.ts`, tests                               | Every item resolves or is reported unresolved with a reason; quotes equal the stored lines                  |
| C. Reply verification                    | Codex                                        | new `verify/packet.ts`, tests                                       | Missing, extra and duplicate pair verdicts are counted; citations checked with existing `verify/` functions |
| D. Offline harness and mock packet model | Codex                                        | new `eval/packetBenchmark.ts`, `scripts/packet-benchmark.ts`, tests | Runs both arms with no API and reproduces on rerun; outputs under `data/raw/`                               |
| E. Review, cost estimate, pilot plan     | Claude, plus an independent reviewer agent   | none (review only)                                                  | Independent check of B to D against labels; a pilot plan with a USD cap for approval                        |

Tasks B, C and D touch disjoint files and can run in parallel worktrees. Only D uses `TEST_DATABASE_URL`, so no two of them share it.

**The next technical objective.** Define the packet verdict contract (task A) and the item-to-stored-line loader (task B). Then run both arms offline on the corpus 1 within-case packets that hold the 4 targets, before any paid call.

## Additional Milestone 2 requirements

### Verdict completeness and abstention

Every listed evidence pair must receive exactly one response entry.

Permitted outcomes must include insufficient evidence, needs more context, or unable to assess.

A missing entry, duplicate entry, or unsupported source reference must be recorded as a validation failure rather than silently omitted.

Do not force a substantive contradiction classification when the available evidence is insufficient.

### Separate evidence verification from interpretation

Record three independent results:

1. Source verification: whether cited evidence exists and matches the stored original testimony.
2. Attribution verification: whether the cited statements are correctly attributed to the witness or another speaker.
3. Semantic classification: the model's interpretation of whether the statements conflict.

Passing source verification must not automatically validate the semantic classification.

### Evaluation fairness

Evaluate the same evidence pairs individually and inside grouped packets.

Report:

- Labelled discrepancies identified and missed.
- Compatible controls incorrectly flagged.
- Abstentions and insufficient-context outcomes.
- Valid citation rates.
- Attribution errors.
- Total token usage and cost.
- Cost per correctly identified labelled discrepancy.

Treat unlabelled evidence as unknown, not automatically as a false positive.

Separate results on real review-worthy examples from synthetic direct contradictions.

### Execution budget

Before any paid run:

- Freeze the exact pilot sample.
- Calculate input tokens using actual serialized requests.
- Include maximum output tokens and retries in the spending limit.
- Reserve the worst-case cost before execution.
- Stop when the approved budget would be exceeded.
- Record actual token usage and API charges.

No paid model calls are authorized yet.

### Milestone completion

Offline implementation and mocked tests establish engineering readiness only.

Milestone 2 is not complete until the real-model pilot has been explicitly authorized, executed, and independently evaluated.

Do not begin Milestone 3 before that review.
