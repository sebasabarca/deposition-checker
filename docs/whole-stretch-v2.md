# Whole-stretch reading (stretch-v2): an optional, experimental case-run contract

**Branch:** `feature/whole-stretch-v2`, from main `96a6ac8`.
**Status:** integrated as a selectable contract, off by default. packet-v1 stays the default contract.
**Accuracy:** not validated. Every result here is from the test model or the fake batch provider, so it proves the pipeline carries stretch requests correctly. It does not show that stretch-v2 finds contradictions.

**DESIGN.md is not changed.** Making stretch-v2 more than an experiment, or the default, is a design change that needs the developer's approval (§7).

## 1. What it is

Packet-v1 asks the model about each listed pair of answers, in small issue packets.

Stretch-v2 instead shows the model the complete stretch of testimony around nearby pairs on each side:
- every exchange between the pairs, not only their ends;
- shown once, as continuous transcript.

It asks for every conflict between the two stretches. It writes a finding only for a conflict, plus a ledger that says every listed pair was checked.

Code, not the model, decides each pair's status:
- **Citations:** production's packet verifier checks every finding's citations against the stored lines.
- **Status:** each original pair then gets one status from the verified evidence alone.

| Status | Meaning | Shown as |
|---|---|---|
| `flagged` | A finding cites exactly this pair, in its unit, and its citations were verified | A finding: verified, scored, packet-v1 rubric |
| `flagged_unverified` | A finding cites exactly this pair, but its citations failed verification, or it was filed under another unit | A finding: unscored, check manually |
| `unclear` | The model said it can't tell, and no finding cites the pair | A count; no finding |
| `no_conflict_identified` | Checked, and no finding cites it | A count; **read, not cleared**. Never "compatible" |
| `incomplete` | Its unit or ledger entry is missing, or the reply failed | Not read: up to two recovery requests, then the entry is incomplete |

- **`related`** is an attribute, not a status: another finding of the unit cites one of the pair's exchanges. It is never turned into a conflict.
- **Disagreements:** when the model's ledger disagrees with its own findings, the verified finding stands and an `INCONSISTENT` audit note is kept.
- **Findings outside the original pairs** are counted on the ledger entry and kept in the raw reply. They are not published.

## 2. What was reused, ported and changed

**Ported from `experiment/candidate-reduction` (31590cd), rules unchanged:**
- units and bundles (`buildUnits`, `bundle`, `pairUnits`: gap 2, 6,000 item tokens, 6 units);
- the reply schema and the system prompt, byte for byte (SHA-256 `b312bfb2…`, pinned by a test);
- strict parsing, per-finding verification, and the per-pair reconciliation.

**Reused from production unchanged:**
- packetLoad passages (r12 segments, part labels);
- `verifyPacketReply`;
- packet-v1 assessment, scoring and persistence for flagged pairs;
- the case-run ledger, Fast execution, Economy (Batches) execution, recovery, the budget reservations, `recordCall`, evidence epochs and reconciliation of stale runs, coverage reporting, and the findings and source viewer.

**Changed, so the pilot's numbers don't transfer as measurements:**

| | Experiment | Production |
|---|---|---|
| Stretches | Frozen from an older parse (r10 and earlier) | Built from the live case pool on current evidence |
| Line shared by two turns | Shown whole | Each exchange's own slice, with its "(part x of y)" label |
| Not-citable lines | Every stored line between exchanges | The passages' own context lines that no shown exchange holds, each shown once |
| Recovery request | Only the incomplete pairs, with their whole blocks | The remaining pairs, with the entry's items |
| Finding filed under another unit | Unverified | Its citations are still code-verified against the stored lines; the misfiling becomes an audit note |

## 3. How it fits the existing architecture

No second job system. A stretch request is expressed as an issue packet: its items are every exchange of its stretches, its pairs the original pairs. Everything downstream of retrieval therefore carries it unchanged.

| Where | What changes |
|---|---|
| `jobs/caseRun.ts` `createCaseRun` | `contract: "stretch-v2"` is stored as the run's `promptVersion` and `config.contract`. A resumed run keeps it |
| `retrieve()` | `buildStretchSet(triage.kept, items)` instead of `splitPacketSet`. The ledger, item index, candidates and estimate are unchanged |
| `entryContext`, `nextStep` | Load every item of the entry (`allItems`), not only its pairs' ends |
| `PACKET_PROMPTS["stretch-v2"]` | The system prompt, schema and renderer: `packetRequestParams`, the live adapter and Batch request bodies follow the contract |
| `applyReply` → `persistStretch` | One transaction with the stored-reply pointer, so a crash never repays |
| Estimate | Stretch cost assumptions from the v2 pilot (53 output tokens per pair, a 3,873-token cached prefix, 2.4 characters per token), labelled a projection |
| API, CLI, case panel | `ALLOW_STRETCH_V2=true` offers it; runs show their contract and the per-status counts |

The Haiku verifier is **not integrated**. Section 6 plans it as an advisory annotation only.

## 4. Retrieval investigation (production pipeline, restored working data)

The trace ran `scripts/target-trace.ts` on `deposition_checker_rehearsal_v2prep`: the restored, migrated copy of `deposition_checker`. Parses there are r10, and the trace uses the default case pool. It sends no model call.

| Target | Side pair | Where it is lost (MiniLM off) | With MiniLM |
|---|---|---|---|
| limo/SUV (June 5:6–6:14 / Sept 33:6–33:13) | Labelled pair | **Retrieved:** pool rank 189 of 2,945, kept, in packet `star-173` and stretch `S107`. Decisive Sept 34:19–24 not shown by either | Rank 125, same |
| limo/SUV probe (June 5:6–6:14 / Sept 34:18–35:12, the decisive answer) | Not a label | **Retrieved:** rank 316, kept, so it is sent to the model as its own pair | Rank 308 |
| C01 | 1:560–561 / 0:781–782 | Retrieved (rank 591, kept). Decisive 1:562–563 shown as context only | Rank 285 |
| C01 | 1:562–563 / 0:781–782 | **Per-item cut:** admitted only at 50 | Admitted at 10 |
| C02 | 1:589–590 / 0:802–803 | Retrieved (rank 2,612, kept) | Rank 1,690 |
| C02 | 1:587–588 / 0:802–803 | **Per-item cut:** not admitted even at 50 | Not admitted at 50 |

**limo/SUV is not a retrieval failure on current main.**
- The pair holding the decisive "the Beast or the Presidential SUV" answer is retrieved and kept, with or without MiniLM.
- The labelled pair is too. Its own request just doesn't show 34:19–24.
- So the miss in every earlier arm happened at adjudication: models judged the answers compatible, or needing context.
- Its label is provisional and second-hand (`milestone-2-results.md`). The errata and House report behind it were not independently checked.
- It is a development case: the earlier alignment prompt was changed after seeing it. It is not held-out evidence.

**C01 and C02 lose side pairs at the per-item fused cut** (5 per item). MiniLM brings one of C01's two sides in at a cut of 10.

**Stretch padding prototype** (`--pads`, retrieval unchanged; it adds eligible items on each side of every stretch):

| Pad | C01 decisive 1:562–563 in its own unit | limo/SUV decisive 34:18–35:12 in its own unit | Simpson–Resnick case: requests / projected Economy | Hutchinson case: requests / projected Economy |
|---|---|---|---|---|
| 0 | context only | no | 752 / $6.92 | 182 / $2.03 |
| 1 | **citable** | no | 753 / $8.77 | 257 / $3.29 |
| 2 | citable | no | 789 / $10.55 | 448 / $5.34 |
| 6 | citable | **citable** | 2,155 / $25.02 | 1,066 / $14.87 |

- **Pad 1** is a narrowly justified candidate for C01: about +27% on that case.
- Uniform padding is no fix for limo/SUV: it needs pad 6, about ×7 on its case.
- Both targets are development cases, and the padding was chosen after looking at them.
- `pad` stays 0 in runs (`STRETCH_SETTINGS.pad`). Wiring pad 1 into runs means a new stretch-set version, and needs a paid comparison first (§6).

**MiniLM in case runs.** It helps C01's second side and costs about +1.5% pool pairs here (14,858 against 14,633). Case runs still default to `minilm: "off"` (`caseRun.ts` `retrieve`). Turning it on is a separate, cheap decision; the model files must be present.

## 5. Tests (no paid call)

**Pure tests** (`tests/adjudicate/stretch.test.ts`, 8):
- the prompt is byte-identical to the pilot's, and the request path and Batch body match;
- units and orientation;
- rendering: one block per session, context shown once, part labels;
- the stretch set covers every kept pair and shows in-between items;
- each status: inconsistency, unverified, swapped sides, incomplete, outside pairs, unparseable replies;
- the test-model reply agrees with packet-v1's test model.

**Postgres tests** (`tests/db/caseRunStretch.test.ts`, 7, synthetic Webb/Whitfield):
- The test model reads the same pairs as packet-v1's test model: 67 no conflict identified = 67 compatible, 38 unclear = 38 insufficient, 0 flagged in both. No compatible-lane finding.
- A scripted model flags every pair: findings are verified, scored, carry `checks.contract` and the stretch status, and show their stored lines. Requests carry in-between exchanges.
- Economy (fake Batches) gives exactly the Fast reading, and every Batch request carries `stretch-v2`.
- Live, with the priced test model, on Fast and Economy: one `llm_calls` row per request, nothing left reserved, and Economy costs exactly half.
- A crash after a paid reply: no second purchase and no duplicate verdict.
- A correction while a live Economy run is pending: `reconciling`, then `failed`. Billed replies are recorded, with no new verdict or finding and nothing reserved.
- API: refused (409 `stretch_disabled`) unless `ALLOW_STRETCH_V2=true`; without a contract a run is packet-v1.

**Browser** (feature worktree, disposable database, test model):
- the option appears only with the flag;
- Fast and Economy test runs complete, labelled "Experimental: whole-stretch reading", with the same counts;
- unchecked, a run is packet-v1.

The test model flags nothing on that synthetic case, so no stretch finding was displayed in the browser. The database test covers that path.

## 6. Preparing accuracy validation (plans and estimates only; nothing was run)

**Independent human labels are required to establish accuracy.**
- The 15-item blinded review set (`frozen-v1/verify-review-v1/`) and about 44 packet-v1/v2 disagreement pairs are unlabelled.
- The 284 + 2 existing labels are model-assisted (`labels-model-assisted-v1/`), not ground truth.
- No accuracy claim below is possible without them.

1. **Repeatability of the frozen V2 model.**
   - Run the frozen 49-request pilot again unchanged, in the experiment worktree: `stretch/v2/pilot.ts --label paid-2`.
   - Production's prompt files changed, so it refuses to run on main by design.
   - Compare with `v2/repeat.ts`: per-pair status agreement, κ, and stability of C01, C02, CW-001 and the C08 false positives.
   - Measured cost is $0.78 per run; the cap already approved in the plan is $6.
2. **packet-v1 against stretch-v2 on identical candidate evidence.**
   - On a restored copy, run case 17 (Simpson–Resnick) with both contracts on Economy, from the same case pool, so the kept pairs are identical.
   - Record per-pair flags in each, their agreement, and every disagreement for human labelling.
   - Projected Economy cost (`expectedUsd`–`noCacheUsd` × 0.5, from the runs' own estimates): see §8.
3. **Retrieval recall and adjudication recall, separately.**
   - Retrieval: `target-trace.ts` per target (eligible, pooled, kept, shown), free.
   - Adjudication: for each target pair that reached the model, the arm's status.
   - Report the two as separate numbers. A target missed at retrieval never counts against the adjudicator, nor the reverse.
4. **False positives by distinct factual issue.**
   - Group flagged pairs by unit and by the cited exchanges' issue, so one misreading counted four times (C08) is one false positive.
   - Then label one representative per issue.
   - The C08 pattern (reported speech against a knowledge disclaimer) is the known one.
5. **Citations and attribution.**
   - Rates from production verification: verified / flagged, and the diagnoses of the unverified.
   - Attribution: compare the experiment's `attribution.ts` warnings (questioner assertion, counsel's words, adoption of a question) on the flagged findings. That module is experiment-only; porting it is a separate task.
6. **Haiku as an advisory verifier.**
   - On the flagged findings of item 2 only, stored separately, never demoting or hiding a finding.
   - Measured: $0.08 for 63 cases with medium effort, so about $0.001–0.002 per finding.
   - Pre-registered criterion, from verify-v1: no target demoted below "needs context".
   - It needs its own approval.
7. **A full-case test.** One multi-witness, many-session case, run on Economy:
   - actual cost against the estimate;
   - wall-clock time, from first submission to last import;
   - coverage: kept, deferred, incomplete, unclear;
   - every "no conflict identified" counted as read, not cleared.

   The working data has no case beyond two depositions per case. A real many-session case must be ingested first, by the developer.

## 7. What blocks optional integration, and making it the default

**Optional integration (merge with the flag off).**
- The code is ready for review. Defaults are unchanged: packet-v1, flag off, pad 0.
- Needed first: the developer's approval of a short `DESIGN.md` note naming stretch-v2 as an experimental contract.

**Making it the default needs:**
1. Human labels on the review set and the disagreement pairs.
2. A repeat run showing stable detection.
3. The packet-v1 comparison on identical evidence (§6.2).
4. A false-positive rate per distinct issue at or below packet-v1's.
5. A real full-case Economy run within its estimate.

The C08 false positive (4 verified flags in the pilot, failing its pre-registered control criterion) is unresolved. So is C01's overstated `direct` outcome, where the decisive words were context only.

## 8. Scale and cost

**Full-scale test-model runs** on the restored working data, case 17 (Simpson–Resnick: 2 witnesses, 7,198 stored lines). Pool pairs were 14,633, of which triage kept 7,751. Free, with the provider pacing lifted for these runs only:

| Run | Requests | Read | Time | Outcome per pair |
|---|---|---|---|---|
| packet-v1, Fast (4 lanes) | 1,432 packets | 1,432 | 14 s | 118 direct · 3,736 compatible · 3,897 insufficient |
| stretch-v2, Fast (4 lanes) | 752 stretch requests | 752 | 11 s | 118 flagged · 3,736 no conflict identified · 3,897 unclear |
| stretch-v2, Economy (fake Batches, 8 batches of up to 100) | 752 | 752 | 53 s (1-s polling) | identical to Fast |

- **Every kept pair is read in both contracts.** The test model's per-pair outcomes correspond exactly.
- **Test-model runs are paced like paid ones** by the default `PROVIDER_REQUESTS_PER_MINUTE=50`: 1.2 s a request, so this case takes about 29 minutes as packet-v1 and about 15 as stretch-v2. This is existing behaviour, not stretch-v2's. Raise the `PROVIDER_*` limits for free test runs if that matters.

**Projected cost on that case** (each run's own estimate: Milestone 2 calibration for packet-v1, the v2 pilot's for stretch-v2). These are projections, not measurements:

| | Fast | Economy (Batch) | Worst case reserved, all requests (Economy) |
|---|---|---|---|
| packet-v1 | $33.29 (no cache $43.33) | $16.64–21.67 | $238.13 |
| stretch-v2 | $8.03 (no cache $13.84) | **$4.02–6.92** | $229.96 |

**Unverified assumptions in the stretch-v2 projection:**
- **Output:** 53 tokens per pair, from 49 requests chosen around known evidence. A case with more real conflicts writes more findings, so costs more.
- **Characters per token:** 2.4, measured on the pilot's rendering, not on this renderer's.
- **Pricing and discount:** Sonnet 5.5 prices, and the Batch discount of 50%.
- **Caching:** Economy assumes no cache hits for its upper bound.
- **Retries:** none beyond a 5% allowance.

The experiment projected $8.6–10.6 on Economy for its 13,384-pair full case; this case has 7,751 pairs.

**Reservations.**
- Every request reserves its worst case: 5,500 output tokens per pair, the same rule as packet-v1. A stretch request bundles up to about 36 pairs, so each reservation is large (up to about $1 on Economy).
- The total worst case is close to packet-v1's.
- A budget near the projection therefore runs few batches at once; the limit is enforced by Veridict, not the provider.
- A smaller per-pair output cap for stretch requests would be a contract change, to be measured first.

**Scale limits not yet exercised:**
- a real case with many witnesses and sessions (none is in the working data);
- a real provider's batch latency (up to 24 hours);
- real replies that fail verification, or are incomplete, at volume.
