# Detection quality: retrieval, attribution and adjudication (November 5, 2026)

No model calls. Everything here is offline: production retrieval on disposable databases, and the frozen real-model
replies of the $2.8966 evaluation (`docs/v2-accuracy-eval.md`, commit 9d85eb4) re-read through production code.
**Offline results show what code changes do to stored replies; they are not new real-model accuracy.**

The paid evaluation is preserved: `data/raw/accuracy-eval/` (frozen requests, trace, 5 run directories,
`score.json`) is write-protected, with SHA-256 of all 16 files in `data/raw/accuracy-eval-v1.preserved.sha256`.

## 1. The 16 labelled pairs, stage by stage

Case 19 (`deposition_checker_rehearsal_v2eval`): the three labelled sessions ingested with parser r12. **Ingestion:**
every labelled line of every pair is stored and lies in an eligible answer group (item); no pair is lost at
ingestion or eligibility. Columns per run: packet-v1 r1, r2, stretch-v2 r1, r2. `E` = exact side pair flagged,
`n` = only an adjacent exchange flagged (factual issue, not the exact pair), `-` = not flagged; then the published
lane before → after the safeguards (`C` = contradiction, `r` = needs-context review lane), and the rules that fired.
Lost pairs were read in the evaluation's oracle requests (given to the model directly).

| Label | Truth | Retrieval (pool rank) | Kept side pairs | p-v1 r1 | p-v1 r2 | V2 r1 | V2 r2 |
|---|---|---|---|---|---|---|---|
| C01 | + | **lost at the per-item cut** | 0/24 | E C→C | E C→C | E C→C | E C→C |
| C02 | + | kept (6,031) | 1/2 | E r→r | - | n | n |
| CW-001 | + | kept (17,697) | 1/20 | E C→C | E C→C | E C→C (reported speech side → one flag r) | same |
| C03 | − | lost | 0/1 | E C→**r** no_recall | E C→**r** | E C→**r** | E C→**r** |
| C06 | − | lost | 0/4 | - | - | - | - |
| C07 | − | kept (10,345) | 1/3 | E C→**r** not_own_knowledge, examiner_words | same | same | same |
| C08 | − | lost | 0/8 | E C→C (some flags r) | E C→C | E C→C | E C→**r** |
| N01 | − | lost | 0/2 | - | - | - | E C→C |
| N02 | − | kept (1,988) | 2/2 | - | - | - | - |
| N03, N05, N07 | − | lost | – | - | - | - | - |
| N04 | − | lost | 0/12 | - | E r→r | E C→C | E C→C |
| N08 | − | lost | 0/1 | E C→**r** not_own_knowledge | E C→**r** | - | - |
| NC-001 | − | kept (636) | 6/12 | E C→C | E C→C | E C→**r** says_compatible | E r→r |
| NC-002 | − | lost | 0/8 | - | - | E C→**r** established_alternative | E C→C |
| limo/SUV (unverified) | (+) | kept (189) | 2/2 | - | - | - | - |

- **Exact-pair detection** (verified positives, any condition): packet-v1 3/3, 2/3; V2 2/3, 2/3.
- **Factual-issue detection** (exact or an adjacent exchange about the same disagreement): packet-v1 3/3, 2/3;
  V2 3/3, 3/3 (C02 is found on the neighbouring answer "I believe so. I'm not sure.").
- In production retrieval only C02 and CW-001 (+) and C07, N02, NC-001 (−) reach the model.
- NC-001's Simpson lines overlap CW-001's (statement 1654), so some NC-001 flags are the CW-001 disagreement read
  through an overlapping pair.

## 2. Why retrieval lost the labelled evidence

1. **The per-item cut is shared by every other session.** `buildPool` keeps each item's fused top 5 partners across
   all other sessions together. In a three-session case, Simpson day 2 and Simpson day 9 are the same speaker on the
   same topics and fill most of those 5 slots, so cross-witness partners (Resnick) are crowded out. 11 of 16 labels
   never enter the pool, all at this cut.
2. **Triage then cuts again.** When a wider selection admits C01's main pair (Simpson 1:560–561 "The dog ran out" /
   Resnick 0:781–782), triage's coverage stage defers it: passage rank 5 from Simpson's side, 42 from Resnick's, with
   2 kept per item.
3. **Root cause for C01: item granularity.** Its evidence is a run of one-line answers whose facts are in the
   questions ("So you stayed outside? Yes." "Where? In the front." "Out of the gate? Yes."). Each item alone carries
   almost no content, so no lexical or semantic path ranks it high against Resnick's "back alley… Not at all."

## 3. Retrieval variants (bounded; `buildPool` selection, off by default)

`scripts/retrieval-variants.ts` (free). Tuning set: the 16 developer labels (case 19, 3 sessions, 4,594 items).
Held-out: `independent-cross-v1` (48 synthetic pairs, AI-written, blind AI review, developer-resolved), all 20
transcripts as one 20-session case. Kept = survives triage. Cost = the case-run projection, fast mode, whole case.

| Variant | Tuning: + kept / − kept | Pool / kept pairs | p-v1 / V2 requests | Projected p-v1 / V2 | Held-out: + kept / − kept | Held-out pool | Held-out p-v1 / V2 |
|---|---|---|---|---|---|---|---|
| baseline (top 5) | 2/3, 3/13 | 20,012 / 10,972 | 2,871 / 1,048 | $47.73 / $10.74 | 21/23, 19/25 | 1,893 | $6.84 / $1.48 |
| top10 (wider) | 2/3 (C01 in pool), 5/13 | 38,531 / 14,892 | 3,446 / 1,182 | $64.50 / $13.89 | 22/23, 22/25 | 3,542 | $9.76 / $2.01 |
| top15 | 2/3, 6/13 | 56,304 / 17,878 | 3,845 / 1,290 | $77.25 / $16.26 | – | – | – |
| session2 (+2 per other session) | 2/3 (C01 in pool), 5/13 | 35,654 / 13,610 | 3,279 / 1,141 | $59.03 / $12.89 | 22/23, 23/25 | **16,490** | $13.13 / $2.70 |
| witness2 | 2/3 (C01 in pool), 4/13 | 34,805 / 13,484 | 3,251 / 1,137 | $58.48 / $12.79 | – | – | – |
| path1 (each path's best) | 2/3, 6/13 | 34,838 / 13,481 | 3,220 / 1,135 | $58.44 / $12.76 | – | – | – |
| minilm | 2/3 (C01 in pool), 4/13 | 20,121 / 11,829 | 2,891 / 1,000 | $51.33 / $11.09 | – | – | – |
| **session2-floor0.85** | 2/3 (C01 in pool), 5/13 | 31,123 / 13,258 | – | **$57.53 / $12.58** | 22/23, 21/25 | **3,380** | **$8.96 / $1.87** |

Order of work (recorded in `data/raw/retrieval-variants/choice.json`): session2 was chosen on the tuning set and
then run on the held-out set once, with baseline and top10. The held-out run showed session2 scales with the number
of sessions (8.7× the pool at 20 sessions). The relevance floor was then added: a quota partner is admitted only at
≥ 0.85 × the item's 5th fused score. Its value was compared on the tuning labels; on the held-out case only the pool
size and cost, which use no labels, were used to judge it. **The held-out labels have now been seen twice, so they
are no longer untouched for the floor variant.**

**Most defensible at scale: per-session quota with a relevance floor.** It is bounded by relevance, not by the
number of sessions: a session with nothing close adds nothing. It equals top10's coverage on both sets at lower cost.
It is not the default, and it does not by itself bring C01 to the model: triage (and granularity) still stop it.
No variant recovered C01 for adjudication without also admitting more controls (C03, C08, N01).

## 4. Safeguards (implemented: `server/src/verify/safeguards.ts`, applied in `adjudicate/packetAssess.ts`)

A conflict verdict (direct or inferential) that trips a rule is published as **needs context**: type
`insufficient_evidence`, priority `needs_context`, unscored. The model's outcome, explanation and alternative stay
on the finding, and `checks.safeguards` lists every rule. Nothing is deleted. It applies to both contracts, since
stretch-v2 flags become packet-v1 verdicts before assessment.

| Rule | Fires when | Does not fire when |
|---|---|---|
| examiner_words | the quoted words are only the examiner's, or are the question and the answer is not a plain yes/no | a plain yes or no adopts the question ("Out of the gate?" "Yes.") |
| not_own_knowledge | the model's own attribution is reported_by_other, hypothetical or attorney_statement | asserted, qualified, unclear |
| no_recall | code reads a no-recall answer, the model says does_not_recall, or the cited answer has a no-recall clause | plain denials; "I remember…", "I recall it clearly" |
| says_compatible | the explanation says both can/could/may be true, or "not clearly/necessarily inconsistent" | "cannot/can't both be true", "not compatible", "not consistent", "consistent with … but contradicts" |
| established_alternative | the verdict rates its own compatible alternative as established | plausible, speculative, none |

Tests: `tests/verify/safeguards.test.ts` (21, each rule with firing and non-firing cases, including the real NC-001
and C03 wording), `tests/adjudicate/packetAssess.test.ts` (+5: published lane, model outcome kept, nothing deleted),
`tests/db/caseRunStretch.test.ts` (updated: a safeguarded stretch finding is unscored, needs context, outcome kept).
`tests/retrieve/poolSelection.test.ts` (4: unchanged default, quota, floor, per-path). Full suite 1,462 passed, 57 skipped; typecheck and client build pass.

## 5. Offline replay of the frozen real replies (`scripts/safeguards-replay.ts`)

| | p-v1 r1 | p-v1 r2 | V2 r1 | V2 r2 |
|---|---|---|---|---|
| Published contradictions, all pairs | 36 → 24 | 33 → 25 | 23 → 15 | 24 → 15 |
| Flags on verified controls published as contradictions | 13 → 3 | 12 → 4 | 11 → 4 | 11 → 3 |
| Verified controls published as a contradiction (labels) | 5 → 2 | 5 → 2 | 6 → 2 | 6 → 3 |
| Flags on verified positives published as contradictions | 20 → 19 | 18 → 18 | 11 → 10 | 12 → 11 |
| Verified positives still published as a contradiction | C01, CW-001 → same | same | same | same |
| Positives surfaced in any lane | unchanged | unchanged | unchanged | unchanged |

Witness attribution: examiner_words fired once per run (C07's "Other than that, no conversation at the recital?
Correct." quoted as the answer). The earlier "attribution failures" of V2 were mostly model-versus-code
disagreements on adopted questions ("So you stayed outside?" "Yes."), which are correct adoption and are left alone.

**These numbers are in-sample.** C07, NC-001 and C03 were read before the rules were written; the rules were kept
narrow and each has non-firing tests, but their effect on unseen testimony is unmeasured.

**What the rules cannot do (still model reasoning):** C08 (a knowledge difference: Resnick's general impression
against a call she could not know of), N01, N04, NC-002 (inferences across different times or settings), NC-001 in
packet-v1, and limo/SUV and C02 (whether two answers describe the same occasion). No deterministic signal separates
these from genuine contradictions in the stored lines.

Cost: the safeguards and the replay add no model call and negligible compute.

## 6. Independent validation (prepared, not run)

**A. The 15-item blinded set (`verify-review-v1`)**, unchanged: `data/raw/candidate-reduction/frozen-v1/verify-review-v1/`
(`blind.jsonl`, sealed `key.json` + `key.sha256`). The tool and sheet are on `experiment/candidate-reduction`
(31590cd): `experiments/candidate-reduction/review/server.ts`, `docs/verify-review-v1-reviewer-sheet.md`.

1. The developer runs the tool from a fresh detached checkout of 31590cd (not the other session's worktree), with
   `data/raw` linked to the main checkout's and a new labels directory:
   `npx tsx experiments/candidate-reduction/review/server.ts --labels data/raw/candidate-reduction/labels-human-v1`.
2. Two reviewers, each alone, no AI assistant, a fixed lower-case reviewer name, the reviewer sheet only. Neither opens
   project folders (`key.json` and model outputs are there).
3. Each reviewer locks their answers. Then the adjudication view shows both, and the developer resolves the
   disagreements.
4. Only then is the key opened, its SHA-256 checked against `key.sha256`, and the sealed scorer run. Nobody runs
   `reviewScore` in a test, since it writes into the frozen set.
5. Labels are recorded as human, with reviewer names and times. No model output is ever shown in the tool, and no
   label is written by Claude.

**B. New, unseen examples** (needed: the 3 positives are all development examples).

1. Source: a new case, never used in development. Options: the Ellison DOJ depositions, which already have a
   hand-labelling file with 0 pairs, or a new public transcript.
2. Sampling, blind to every model: take pairs from the revised retrieval's kept pool by stratified random sampling
   across fused-rank bands, plus a random sample of pairs it did not keep, so misses can be counted. Shuffle them, and
   show no model output.
3. Labelling: the developer, with a second reviewer if possible, in the same tool and with the same categories.
   Freeze the labels before any model run, and split them into tuning and held-out halves.

**C. A controlled real-model comparison (needs new authorisation).**

- **Arms:** (1) the baseline: production retrieval, no safeguards. (2) The revised pipeline: session2-floor0.85
  retrieval plus the safeguards.
- **Identical evidence:** both arms get the same requests for every pair both retrieve. The revised arm also gets
  requests for pairs only it retrieves. The safeguards are code, so arm 2 re-reads arm 1's replies plus those extra
  requests. That isolates each change.
- **Contracts:** packet-v1 and stretch-v2, each run twice, through `scripts/accuracy-eval.ts`, frozen first. Its one
  ceiling is reserved per request.
- **Budget:** on a set like this one, about $0.75 per packet-v1 run and $0.30 per V2 run, so about $2.10 for 2 runs
  of each. The extra requests from the revised retrieval add about 20–30%. **A $4 cap** covers both contracts twice
  with margin. A full-case run is out of scope.
- **Reported:** exact-pair and factual-issue detection, controls published as contradictions and as needs context,
  citations, attribution, repeatability, and cost per request and per valid finding. Development and held-out labels
  are reported separately.

## 7. Unproven

- Generalisation of both the retrieval variant and the safeguards: no independent verified positive exists.
- Real-model behaviour under the revised retrieval: the newly admitted pairs have never been sent to a model.
- C01-type granularity: no bounded retrieval change here brings it to the model. An item representation that carries
  the governing question across short answers is the likely structural fix, and it isn't built.
- Whether "needs context" findings are reviewed in practice; the lane exists, but its use is untested with lawyers.
