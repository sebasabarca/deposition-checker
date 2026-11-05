# Whole-stretch V2: real-model accuracy evaluation (November 5, 2026)

Authorised: $6.00 hard ceiling. **Spent: $2.8966** (145 calls, 0 failures, 0 retries, 0 recovery requests).
Model `claude-sonnet-5-5`, effort medium, production prompts and schemas (packet-v1 and stretch-v2), sent through
`server/src/adjudicate/packetModel.ts`. Runner: `scripts/accuracy-eval.ts`; data (git-ignored):
`data/raw/accuracy-eval/` (`frozen/`, `runs/`, `score.json`).

## 1. Labels: what counts as ground truth

| Set | Decided by | Used here as |
|---|---|---|
| Simpson-Resnick cross-v2: C01, C02, CW-001 (review-worthy, "needs context") | the developer (Nov 3) | the only verified positives: **3, all development examples** |
| Simpson-Resnick controls (13) | the developer | verified negatives. C08, NC-001 were development controls; C07, N03, NC-002 were seen in the verifier pilot after stretch-v2 was frozen; **C03, C06, N01, N02, N04, N05, N07, N08 were never used** |
| limo/SUV | proposed by Claude, "awaiting the developer's decision" | **unverified**; reported alone, in no rate |
| 284 + 2 model-assisted labels, the 15-item review set | no human decision | not used (no ground truth) |
| 10 "reviewed" findings in the working DB | test clicks (Webb is synthetic; notes "hello"; seconds apart) | not used |

There is **no independent verified positive**. Recall below is over 3 development examples and is not a test of generalisation.

## 2. Retrieval, separated from adjudication (free)

Fresh disposable case (`deposition_checker_rehearsal_v2eval`, case 19): the three labelled sessions ingested with the
production parser (r12). The working DB's Simpson-Resnick case lacks the Feb 27 session (9 labels), so it was not used.
Production pool: 4,594 items, 20,012 pool pairs, 10,972 kept.

| Label | Both passages stored | In pool (best rank) | Kept | Request (packet-v1 / stretch-v2) |
|---|---|---|---|---|
| C01 (+) | yes | **no** (per-item cut) | no | none: retrieval failure |
| C02 (+) | yes | 1 of 2 side pairs (6,031) | yes | star-990 / S755 |
| CW-001 (+) | yes | 1 of 20 (17,697) | yes | issue-194 / S963 |
| C07, N02, NC-001 (−) | yes | yes | yes | in production requests |
| C03, C06, C08, N01, N03, N04, N05, N07, N08, NC-002 (−) | yes | **no** | no | none |
| limo/SUV (unverified) | yes | yes (189) | yes | star-173, issue-12 / S107, S114 |

Every labelled line is stored and in an eligible item. Losses are all at the pool's per-item cut, none at triage or
packet construction. To separate the two failure kinds, every labelled side pair retrieval did not keep was also sent
as an **oracle** request (the same production builders, given the pair directly).

## 3. Runs

| Run | Requests | Pairs | Cost |
|---|---|---|---|
| labelled, packet-v1, r1 / r2 | 31 (11 production + 20 oracle) | 163 | $0.7781 / $0.7481 |
| labelled, stretch-v2, r1 / r2 | 17 (9 + 8) | 205 | $0.3103 / $0.2956 |
| frozen 49-request V2 pilot, repeat | 49 | 611 | $0.7645 (first run: $0.7849) |

Identical frozen request texts in both runs of each arm. Both arms read the same labelled pairs; each uses its own
production packaging (stretch requests carry more neighbouring pairs).

## 4. Results on verified labels (exact side pairs)

| | packet-v1 r1 | packet-v1 r2 | stretch-v2 r1 | stretch-v2 r2 |
|---|---|---|---|---|
| **Production**: positives detected (of 3) | C02, CW-001 | CW-001 | CW-001 | CW-001 |
| Production: controls flagged (of 3 retrieved) | 0 | 0 | **C07, NC-001** | **C07, NC-001** |
| **Oracle**: positives detected | C01, CW-001 | C01, CW-001 | C01, CW-001 | C01, CW-001 |
| Oracle: controls flagged (of 12 sent) | C03, C07, C08, N08, NC-001 | + N04 | C03, C07, C08, N04, NC-002 | + N01 |
| Any condition: positives (recall over 3 dev examples) | 3/3 | 2/3 | 2/3 | 2/3 |
| Any condition: controls flagged (of 13) | 5 | 6 | 6 | 7 |
| Never-used controls flagged (of 8) | 2 (C03, N08) | 3 | 2 (C03, N04) | 3 |
| Label-level precision (positives ÷ labels flagged) | 3/8 | 2/8 | 2/8 | 2/9 |
| Near only (adjacent exchange flagged, not the labelled one) | – | – | C02 | C02 |

| Flag quality | packet-v1 r1 | r2 | stretch-v2 r1 | r2 |
|---|---|---|---|---|
| Flags (all pairs) | 39 | 39 | 28 | 29 |
| Citation verified | 39 | 38 | 27 | 28 |
| Witness attribution checks pass on both sides | 38 | 37 | 24 | 25 |
| Flags on unlabelled pairs (unscored) | 4 | 3 | 2 | 2 |

**limo/SUV (unverified):** not flagged by either arm in any run (production; both side pairs kept).

## 5. Repeatability

| | packet-v1 (labelled) | stretch-v2 (labelled) | stretch-v2 (pilot, 611 pairs) |
|---|---|---|---|
| Pair-level agreement / κ | 0.89 / 0.70 (18 flips of 163) | 0.94 / 0.74 (13 of 205) | κ 0.80 (16 flips of 611); events Jaccard 0.81 |
| Label-level changes | C02 (production) and N04 flip | N01 flips | none: C01, C02, CW-001 exact both runs; C08 flagged both runs |

## 6. Cost (measured)

| | packet-v1 | stretch-v2 |
|---|---|---|
| Per request | $0.0246 | $0.0178 |
| Per pair read | $0.00468 | $0.00148 (pilot: $0.00125) |
| Per flag | $0.0196 | $0.0106 |
| Per verified positive detected (r1) | $0.26 | $0.16 |

V2 reads a pair about 3.2× cheaper. Full-case figures are projections only: at these per-pair rates, case 19's 10,972
kept pairs would be about $51 (packet-v1) against $16 (V2) in fast mode, half with Economy, assuming the labelled
requests are representative (they were chosen around labels).

## 7. Failures and causes

| Case | Cause | Evidence |
|---|---|---|
| C01 missed in production | **retrieval cutoff** (never enters the pool) | both arms detect it in both oracle runs |
| C02 | **insufficient context / model reasoning** (which visit "this visit" is) | packet-v1 flips between runs; V2 flags the adjacent exchange instead, in both runs |
| C07 flagged by V2 in production | **model reasoning: reported speech** (Resnick relays Nicole) read as a conflict | packet-v1 rejects it in production, but flags it in oracle; the rubric already caps such findings (`side_not_adopted_or_no_recall`) |
| NC-001 flagged by V2 | **classification inconsistency**: the explanation says "both can be true… not clearly inconsistent" | the same request, both runs |
| C08, C03 flagged when given the evidence (both arms) | **model reasoning**: knowledge difference, "I don't recall" read as denial | known from verify-v1; production avoids C08 only because retrieval drops it |
| V2 attribution failures (4 of 28) | **incorrect attribution**: the examiner's question quoted as the witness, a null phrase | packet-v1 has 1 of 39 |
| Citation rejections | rare in both: 1 V2 flag `not_cited`, 1 packet-v1 | – |
| limo/SUV (unverified) | **model reasoning** (kept, read, judged compatible) | not a retrieval failure |

Smallest likely improvements, none implemented:
1. Retrieval: let C01-type pairs into the pool (MiniLM, or a per-item cut of 10), then re-measure the controls it also admits.
2. A deterministic gate (code, not prompt): a flag whose own explanation or alternative states compatibility, or whose side is reported speech, goes to "needs context" and is never a contradiction. It must be validated on new labels, since these failures were seen first.
3. Attribution: reject a key phrase that is the examiner's question (already detectable).
4. Labels: an independent, developer-decided set of positives is required before any rate means anything.

## 8. Answers

1. **More genuine contradictions?** No. In the same production pipeline V2 found 1 of 3 developer-labelled positives in each run; packet-v1 found 2 of 3, then 1. With the evidence given directly, both found the same 2 (C01, CW-001).
2. **Fewer false positives?** No. On the 3 retrieved controls V2 flagged 2 in both runs, packet-v1 flagged none. With evidence given directly they are equal: 5–7 of 13 controls flagged, 2–3 of the 8 never-used controls.
3. **Reliable across runs?** Yes, somewhat more than packet-v1: κ 0.74 against 0.70 on the same pairs, and κ 0.80 on the 611-pair pilot with every target outcome repeated.
4. **Cost difference?** Measured: V2 is 3.2× cheaper per pair and 1.8× cheaper per flag.
5. **An improvement?** Not on detection quality. It is cheaper and as stable, with equal or worse precision and recall on these labels, and weaker attribution.
6. **Recommendation: revise, don't abandon, and don't make it the default.** Keep it behind the flag as a cheap first pass. Fix the cheap, measurable gaps (the reported-speech/compatibility gate, the examiner-question check, the C01 retrieval loss), then re-test on independent developer-labelled positives. Without those labels, no contract choice is supported by evidence.

Demonstrated: everything in sections 2–6, on these 16 developer-decided labels (3 positives, 13 controls). Estimated: the
full-case costs. Unresolved: generalisation (no independent positive), C02's correct reading, and limo/SUV's label.
