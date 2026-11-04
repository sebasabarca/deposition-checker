# Milestone 2.5: evidence correctness and adjudication reliability

Done offline on November 4, 2026. No paid model call. Retrieval and screening are unchanged, and no experimental strategy became a default. `packet-v1` is untouched and stays selectable; re-checking both v1 runs gives byte-identical results.

## A. Evidence completeness

`packet-v2` loads each passage's **adjacent exchanges**: the logical exchanges just before and after the cited one (`resolvePassages(..., adjacentOptions)`, `server/src/adjudicate/packetLoad.ts`).

What each adjacent exchange keeps:

- It comes from the same deposition, so the same witness, read whole from the stored lines.
- It keeps its own exchange ID, page:line and line roles.
- It is shown, never merged into the cited exchange.

When an adjacent exchange is left out:

- when it is longer than 12 lines;
- when it sits across omitted pages.

Stored segmentation was not changed, so frozen benchmarks and stored IDs stay valid.

The model may cite an adjacent exchange. The verifier then checks the phrase in that exchange and records `cited: "adjacent"`, so support taken from context is never counted as the candidate exchange itself. Citing the other side's exchange, or one of its neighbours, fails as "both sides cite the same passage".

What this fixes, in the pilot's terms:

- **C01:** the decisive "Out of the gate? / Yes." (1:562–563) is now citable exchange E1123. Before, it was anonymous context.
- **Resnick:** her side gains "So the Sunday would be June 5? / June 5." (E5314).

**Missed-cause split.** Each missed labelled target is now classed `evidence_incomplete` (the request didn't show every labelled item) or `interpretation` (it showed them all). On the saved v1 pilot outputs:

| Target | Cause |
|---|---|
| C01 | `evidence_incomplete` |
| C02 | `evidence_incomplete` |
| limo-suv | `interpretation` |

This is the same diagnosis the independent evaluator reached. The split works at the level of frozen items. A labelled line outside every frozen item, such as limo-suv's 34:19–24, cannot be detected.

## B. Deterministic verification

Changed files: `server/src/verify/text.ts` and `answers.ts`. Regression tests: `tests/verify/readingFixes.test.ts`; each fix's test failed before the change.

| Problem | Fix |
|---|---|
| OCR pipes ("A \|didn't.") | read as noise, or as "I" when glued to a word (the rule `normalize()` already used) |
| Speaker labels | `spoken()` also strips "Q:"/"A:", OCR "0:", capitals labels ("O.J. SIMPSON:"), and titled names ("Ms. Hutchinson. …") |
| Question-negation scope | negation and tag checks read only the interrogative sentence, not an attorney's preamble |
| Tag questions | a plain yes or no to a positive statement with a confirming tag (", correct?") adopts or denies it; negative statements with a tag stay uncertain |
| Clause-level hedges | a hedge qualifies only its own clause (", and", " but"); disclaimers still govern the clause they introduce |
| Bare-answer stance | defined in the `packet-v2` prompt (a bare answer stands for its question: a yes affirms, a no denies), since `packet-v1`'s rule was ambiguous |
| Citations of context exchanges | see A |

Source matching was not loosened. A phrase that is not in the cited exchange still fails.

**Effect on the saved v1 pilot outputs**, re-checked offline:

- Real-testimony attribution disagreements fell from 27 to 24 (pairwise) and from 26 to 22 (packet).
- All 12 OCR-pipe disagreements are gone.
- Stance conflicts rose, from 5 to 11 and from 1 to 7. Answers the verifier used to read as uncertain now read as plain denials, which exposes `packet-v1`'s ambiguous stance rule rather than hiding it.
- Citation validity and the targets found did not change.

Still open:

- One "perhaps" scope case (Hutchinson 116:2).
- The model's "qualified" against code's "uncertain" for hedged answers ("I believe. yes."), 12 to 14 cases. Both labels describe the same thing.

## C. `packet-v2` contract

`server/src/adjudicate/packetSchema.ts` and `packetPrompt.ts`, beside v1. `PACKET_PROMPTS` selects the version, and `--prompt packet-v2` selects it in the scripts.

**Outcomes:**

- direct
- inferential (review-worthy)
- compatible
- clarification_or_correction
- secondhand_or_uncertain
- insufficient_evidence
- needs_more_context
- unable_to_assess

**The verdict:**

- A conflict must list `detailsCompared`, quoted from the cited lines.
- Code flags these as consistency issues, kept separate from evidence validation:
  - a direct verdict with no detail that differs;
  - a direct verdict whose conflict basis is inference;
  - a conflict with no details.
- The strict schema rejects any confidence or score, and any v1-only field.

**The prompt:**

- Lines are tagged with their role: [Q], [A], or [other] for attorney remarks and colloquy.
- It forbids inventing or assuming dates, events, people or chronology.
- It was written from general failure kinds, not from benchmark text.

**Scoring:** "identified" still means a direct or inferential verdict with valid citations, so v1 and v2 compare directly. v2's review outcomes are reported apart as `surfacedForReview`; they never count as identified, and never as a flagged control.

## D. Historical reproducibility

**The audit.** `scripts/audit-findings.ts` is read-only and refuses a writable connection. It recomputes all 1,265 stored findings and names the cause of each difference, part by part. With `--previous <report>` it uses an audit of the previous verifier as evidence. The report is written to `data/raw/audits/`.

**The version marker.** `server/src/verify/version.ts` sets `VERIFICATION_VERSION = "verify-2026-11-04"`, with a header listing what changed in each version. New findings store it in their `checks`; older rows read as "unversioned".

**No stored finding was rewritten.**

Of the 1,265 stored findings, **138** change score or band on today's code:

- **17** are direct-discovery findings. They aren't scored by the pairwise scorer, so recomputing them through it is not applicable. Their own evidence-strength scores reproduce exactly. The 6 reviewed findings that appear in this list are among these 17.
- **121** are findings scored by the pairwise scorer. At the previous commit, 101 of them already differed, which makes 118 together with the 17. The reading fixes newly change **20**.

Causes of the 121 (a finding can have more than one):

| Cause | Findings |
|---|---|
| Path A claims removed (Oct 31): the −5 "Path A tag disagrees" factor no longer applies | 94 |
| Uncommitted Oct 29 fixes before the baseline (bare answers, hedges, consistency check, priority routing, page-gap label) | 16 |
| The reading fixes (verify-2026-11-04), attributed only where an audit of the previous verifier shows that part unchanged | 14 |
| Unexplained: #1102 and #1156, where the Nov 1 OCR-bar fix and the new pipe reading combine | 2 |
| **Sum** | **126** |

126 counts 5 findings twice, which leaves 121:

- Path A plus the Oct 29 fixes: 2
- Path A plus the reading fixes: 2
- The reading fixes plus an unexplained part: 1

Band moves: 27 medium→high, 4 medium→unscored (inconsistent verdict), 1 high→medium, 1 low→medium.

Another **1,036** findings differ without any change to score or band:

| Cause | Findings |
|---|---|
| Factor labels reworded only ("Claude's" → "the analysis's"; same points) | 940 |
| Factor labels reworded, plus the reading fixes | 60 |
| Path A only | 12 |
| The reading fixes only | 11 |
| Other combinations | 13 |

No reviewed finding is affected. #1102 (analysis 15) goes from 67 medium to 77 high, because its OCR-pipe answer now reads as a clear denial.

**Recommendation: re-score nothing.** Show `rubric_version` and the verification version in the API and UI, so a stored score is never compared with a recomputed one unknowingly.

## E. Evaluation preparation

**Free regression on saved responses.** `scripts/packet-benchmark.ts rescore` re-verifies any finished run under its own contract and today's verifier. Both v1 runs were re-checked; the numbers are above.

**Comparison sample.** The frozen `data/eval/packet-v2-eval-v1.json` has 21 packets and 78 pairs:

- the 12 calibration packets: all 4 real targets, the real control C07, and synthetic attribution and needs-context cases;
- held-out real controls not examined while writing v2: C08, N02 and NC-001;
- held-out synthetic B-set packets: B01-S2, B03-S2, B02-R1 and B04-R1 targets, the B01-N1 and B02-N1/N2 controls, and the control packets flagged in v1.

**What a paid v2 run would show.** v1 replies for all 21 packets already exist in the pilot, so only v2 needs paid calls. On these packets v1 measured $0.92, split $0.55 pairwise and $0.37 packet. v2's input is about the same size, because adjacent exchanges replace the context lines, and its output is somewhat larger. Expected cost is about $1.20.

## Acceptance

| Criterion | Evidence |
|---|---|
| Targeted regression tests pass | 1,247 tests in 115 files, the full suite |
| Typecheck and real-data evaluations valid | typecheck clean; 39 of 39 and 79 of 79 checks; client build passes |
| Provenance intact | adjacent exchanges keep their own IDs, roles and page:line; tested against stored rows |
| Incomplete testimony represented | the C01 and Resnick date exchanges are now citable evidence |
| Every finding keeps verifiable evidence | the verifier checks each cited exchange and records whether it is adjacent |
| Historical scores auditable | the audit script, `--previous` evidence and the version marker; nothing rewritten |
| The original strategy remains available | `packet-v1` unchanged; v1 re-checks byte-identical |
| No screening strategy became a default | screening untouched |

Model accuracy on v2 is **not** yet measured.

## Round 2: reliability fixes and packet-v3 (November 4, offline)

No paid call was made. The v1 and v2 contracts are pinned by checksum tests, and `packet-v1` stays the default.

### 1. Shared-neighbour provenance

The verifier keeps a registry of every exchange shown in a packet.

- **Every relationship is kept.** An exchange records which passage it is the exchange of, and every passage it borders. One exchange can border two passages, or be one passage's exchange and another's neighbour.
- **Citations resolve from the citing side.** A shared neighbour can support either passage, and is never reassigned to the wrong one.
- **Invalid stays invalid.** Citing the other side's neighbour still fails ("both sides cite the same passage"). So does citing another passage of the packet.

### 2. Citation diagnostics

A rejected citation now carries a `diagnosis`, and `foundIn` when the quote is found elsewhere:

| Diagnosis | Meaning |
|---|---|
| `invalid_exchange_id` | the cited ID isn't any exchange shown in the packet |
| `cites_other_side` | the ID belongs to the pair's other passage or its neighbours |
| `cites_other_passage` | the ID is another passage of the packet, not in this pair |
| `phrase_in_other_exchange` | the quote is in exactly one other shown exchange, which is named |
| `phrase_in_several_exchanges` | the quote is in more than one other shown exchange |
| `phrase_in_context_lines` | the quote is only in a passage's plain context lines, which can't be cited |
| `unsupported_quotation` | the quote is nowhere |

The model's reply is never changed.

**On the saved v2 replies:** 15 of the 16 rejected sides are `phrase_in_other_exchange`, and the exchange named is always the side's own neighbour (9 packet, 6 single-pair). The last one is `phrase_in_several_exchanges`.

**On the saved v1 replies:** 43 of the 52 rejected sides are `phrase_in_context_lines`. The rest: 9 `unsupported_quotation` and 1 `phrase_in_other_exchange`.

### 3. Completeness

`parseVerdictsLenient()` keeps every well-formed verdict and reports each malformed one. Each pair ends in one of these statuses:

- `answered`: exactly one well-formed verdict.
- `missing`: no verdict.
- `duplicate`: two or more entries, counting malformed ones.
- `malformed`: one entry, which failed the schema.
- `request_failed`: the whole request failed.

Unknown pair IDs are listed. Only `answered` carries an outcome, so a missing or broken verdict is never read as compatible.

`recoveryPlan()` builds at most one follow-up packet, holding only the unresolved pairs and their passages. It is a plan only: nothing sends it.

On the saved runs, v2's packet star-198 shows 3 `missing` verdicts and 1 pair is `request_failed` (the 502). v1 has no incomplete replies.

### 4. Semantic consistency

Two kinds of check, kept apart:

- **Deterministic `consistencyIssues`:**
  - an ungrounded conflict;
  - a direct verdict with no differing detail;
  - a direct verdict whose basis is inference;
  - a conflict with no details;
  - v3 only: a detail quote that isn't in that side's citations.
- **Heuristic `reviewFlags`, which decide nothing:**
  - `explanation_says_compatible` (a conflict outcome) and `explanation_says_conflict` (a compatible outcome), with negations ignored;
  - `detail_names_unseen_specific`: a date, number or name in a compared detail that appears in neither side's shown lines or the witnesses' names. Page:line references and exchange IDs are ignored.

`requiresReview` is set when either kind fires.

**Both known self-contradicting v2 verdicts are caught deterministically:**

- star-1504 R1: `ungrounded` and `direct_without_different_detail`, plus the `explanation_says_compatible` flag.
- star-1064 R6: `ungrounded` and `conflict_without_details`.

**Pairs needing review on v2:** 8 of 78 (packet) and 10 of 78 (single-pair). A first version of the detail check flagged every paraphrase (61 of 75); it was narrowed to unseen specifics.

**Strict identification:** a target that is identified and has no deterministic issue. It equals the ordinary count on the v1 and v2 runs, but not on v3: 4 against 7 (packet) and 3 against 6 (pairwise). Most of v3's issues are `detail_not_in_cited_evidence` hits that quote another line of the same cited exchange (see v3 results).

### 5. `packet-v3`

`packetSchema.ts` and `packetPrompt.ts`. It shows the same evidence as v2.

**The contract:**

- Each side lists up to three `{exchangeId, quote}` citations; the first is its key statement. A question and its answer in the next exchange are two citations.
- Each compared detail quotes those citations.
- `needs_more_context` has explicit triggers: an unresolved reference, an occasion that may or may not be the same, or a question whose answer isn't shown.
- Every pair must be answered.
- The explanation must agree with the outcome.

**The prompt** names no benchmark case (a test checks this). The schema rejects scores. A mock dry run over the 21-packet sample answered all 78 pairs in both arms.

### 6. Packet size

From saved outputs only: `docs/packet-size-analysis.md` and `scripts/packet-size-analysis.ts`. Each pair's packet result is compared with the same pair sent alone, so pair difficulty is controlled.

- **v1:** error rates rise with packet size in both arms (Spearman 0.41 packet, 0.37 single-pair). The difference between them is flat (0.05). That suggests harder pairs end up in large packets, rather than packing causing errors.
- **Above 8 pairs**, packet verdicts agree less with the single-pair ones (Fisher p = 0.015 on outcomes). But that rests on 4 packets, and mostly on one, issue-118 (p = 0.13 without it).
- **v2** is too small to judge by size.
- **Proposal:** at most **8 pairs** per packet and about **9,000 input tokens**. A cautious bound, not a measured threshold.

### Still open

- No model accuracy is measured for v3.
- The real evidence is still 4 targets.
- limo-suv's labelled lines lie outside every frozen item.
- The model and code label hedged answers differently ("qualified" against "uncertain").
- Packets above 8 pairs are untested beyond issue-118.
- The recovery plan has never been exercised against a real incomplete reply.

## packet-v3 paid validation (November 4)

**The run:** $1.16 of an approved $2.50 cap.

- 119 requests: the 99 main requests, plus 20 repeats of issue-118, star-2182 and star-198.
- Every request answered: no failures, retries, missing, malformed or duplicate verdicts.
- Outputs in `data/raw/packet-pilot/v3-eval/`.
- An independent evaluation agent compared v1, v2 and v3 on the same 78 pairs. v3 shows the same evidence as v2, so v3 against v2 isolates the contract; v1 differs in both evidence and instructions.

| Same 78 pairs (11 targets, 10 controls) | v1 packet | v1 pairwise | v2 packet | v2 pairwise | v3 packet | v3 pairwise |
|---|---|---|---|---|---|---|
| Targets identified | 8 | 8 | 8 | 9 | 7 | 6 |
| ...strict (no consistency issue) | 8 | 8 | 8 | 9 | 4 | 3 |
| Controls flagged | 3 | 2 | 2 | 2 | 3 (+C07) | 2 |
| Pairs with an invalid citation | 7 | 7 | 10 | 6 | 5 | **0** |
| Missing, malformed or duplicate verdicts | 0 | 0 | 3 | 0 | **0** | **0** |
| insufficient_evidence / needs_more_context | 3 / 0 | 1 / 7 | 1 / 0 | 4 / 0 | 12 / 6 | 19 / 7 |
| Cost, 99 main requests | $0.39 | $0.55 | $0.41 | $0.61 | $0.40 | $0.55 |

**What improved:** completeness, and citations. The pairwise arm had valid citations on all 78 pairs. Every rejected v3 citation is a quote from the side's own neighbouring exchange given the wrong ID, never invented text.

**What regressed:**

- **B04-S2**, found by v1 and v2, is now needs_more_context in both arms: the model misidentified who a neighbouring exchange referred to. The deterministic detail check caught it.
- **B02-R1** (pairwise) and **C02** (pairwise, against v2) are missed.
- **C07** is flagged in the packet arm. It flipped in v1's own repeat too, so it is unstable rather than newly broken.
- **Abstentions rose sharply.**
- **The real targets did not improve.** limo-suv and C01 are missed everywhere. v3 pairwise lists C01's decisive detail as different, yet answers compatible, and no check catches that. CW-001 is found by all.

**Run-to-run variation:**

- v3 pairwise changed 0 of 17 repeated outcomes.
- v3 packet changed 3 of 17, all flips in whether the pair is flagged, in the 10-pair issue-118 and in star-198.
- v1 grouped repeats vary similarly.

**Verdict: not ready. packet-v1 stays the default.**

Open questions for any next step, not started:

1. Whether needs_more_context with valid citations should count as surfaced for review.
2. Narrowing `detail_not_in_cited_evidence`, so a quote from another line of the same cited exchange isn't an issue.
3. A check for an outcome that contradicts the model's own "different" detail.
4. Preferring the one-pair arm, or a stricter packet cap, given grouped variation.
5. A larger held-out real set: a difference of 1–2 targets is within run-to-run noise here.


## Closing Milestone 2.5 (November 4)

**Final default: `packet-v1`.** `packet-v2` and `packet-v3` stay as separately versioned experimental contracts, selected only with `--prompt`, and their texts are pinned by checksum tests. The following are kept:

- shared-neighbour provenance;
- citation diagnostics;
- lenient parsing and the completeness statuses;
- the bounded recovery plan (never invoked);
- the score audit and the verification version.

Historical findings were never rewritten. Every paid response, call log and report is preserved under `data/raw/packet-pilot/`.

### Three kinds of result, kept apart

1. **Verified evidence (code):** whether each cited quote is in the stored lines of the exchange it names, and whether that exchange is the pair's own or a neighbour. When a quote is wrong, the diagnosis says why. Deterministic; only the stored transcript decides.
2. **Semantic interpretation (the model):** the outcome, stances and compared details. Code checks only its internal consistency: deterministic `consistencyIssues`, plus heuristic `reviewFlags` that decide nothing. Passing (1) never validates (2).
3. **Review-worthy uncertainty:** clarification or correction, secondhand testimony, needs more context, or insufficient evidence. These are reported as such, never as a detection or as a compatible result.

### Evaluation categories

`scoreArm` assigns each labelled pair one category, reading all its rows in a fixed priority order. The exact-match metrics are reported alongside.

**Targets**

| Category | Meaning |
|---|---|
| correct contradiction | direct or inferential, with valid citations |
| surfaced for review | clarification or secondhand, with valid citations |
| appropriate uncertainty | needs more context or insufficient evidence, only where the label says the target needs context or is only review-worthy. For a confirmed direct contradiction it is a miss |
| unsupported evidence | a conflict claimed with invalid citations |
| missed | everything else |

**Controls**

| Category | Meaning |
|---|---|
| incorrect contradiction | a conflict claimed on compatible testimony |
| surfaced for review | not a contradiction, but noise for the reviewer |
| correct | compatible, or an abstention |

**Exact match** compares the outcome with each label class's expected outcomes (`EXPECTED`), reported as matched / of:

| Label class | Expected outcomes |
|---|---|
| conflict | direct |
| conflict_needs_context | inferential or needs_more_context |
| review_worthy | direct or inferential |
| control | compatible or false_positive |

**On the 21-packet sample** (`scripts/packet-benchmark.ts compare`, from the saved outputs; 11 targets, 10 controls):

| | v1 grouped | v1 one-pair | v2 grouped | v2 one-pair | v3 grouped | v3 one-pair |
|---|---|---|---|---|---|---|
| Correct contradiction | 8 | 8 | 8 | 9 | 7 | 6 |
| ...strict (no consistency issue) | 8 | 8 | 8 | 9 | 4 | 3 |
| Surfaced for review | 0 | 0 | 0 | 0 | 0 | 1 |
| Appropriate uncertainty | 1 | 1 | 0 | 0 | 2 | 2 |
| Unsupported evidence | 0 | 0 | 0 | 0 | 0 | 0 |
| Missed | 2 | 2 | 3 | 2 | 2 | 2 |
| Controls: incorrect contradiction | 3 | 2 | 2 | 2 | 3 | 2 |
| Exact match: direct (of 4) | 4 | 3 | 3 | 3 | 3 | 3 |
| Exact match: needs context (of 4) | 2 | 2 | 3 | 4 | 3 | 4 |
| Exact match: real review-worthy (of 3) | 0 | 0 | 0 | 1 | 0 | 0 |
| Exact match: controls (of 10) | 7 | 8 | 5 | 6 | 6 | 7 |
| Pairs with an invalid citation | 7 | 7 | 10 | 6 | 5 | 0 |
| Unanswered pairs | 0 | 0 | 3 | 1 | 0 | 0 |

**What it means:**

- No version reliably detects the real review-worthy discrepancies: real exact match is 0 or 1 of 3, and CW-001 is the only real target any version finds.
- v3 trades contradictions for appropriate uncertainty, with the cleanest citations.
- With 11 targets each sent once, differences of one or two are within run-to-run noise.

### Known correctness limitations carried into Milestone 4

1. Real-testimony detection is not validated. The real evidence is 4 targets, and limo-suv's labelled lines lie outside every frozen item.
2. The model misreads context in specific cases (C01's outcome contradicts its own "different" detail; B04-S2's person) that no deterministic check catches.
3. The model and code label hedged answers differently ("qualified" against "uncertain"); one hedge-scope case is still open (Hutchinson 116:2).
4. Grouped packets vary more between runs than single pairs.
5. `detail_not_in_cited_evidence` (v3) also fires on correct quotes from uncited lines of the same exchange.
6. 118 historical findings (138 on today's code) recompute differently from what is stored, all explained by the audit. They are left as stored, and none is reviewed.
