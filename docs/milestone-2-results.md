# Milestone 2 results: packet versus pairwise adjudication

Measured on November 3, 2026 with Claude Sonnet 5.5, effort medium and the `packet-v1` prompt (`server/src/adjudicate/packetPrompt.ts`). Both arms used the same prompt, schema, per-pair output allowance (5,500 tokens) and stored evidence. A pairwise request is a packet holding one pair. An independent Claude evaluation agent reviewed the results. The raw outputs and per-pair results stay in the git-ignored `data/raw/packet-pilot/`.

**What this shows.** On a frozen retrieval sample, grouping pairs into issue packets did not change which labelled targets the model found, and it cost less. **It does not show whole-case detection accuracy, and real-world contradiction detection is not yet validated.** The real-testimony evidence rests on 4 review-worthy targets, and the model found only 1 of them in either arm.

## Sample

The frozen `data/eval/packet-pilot-v1.json` holds 60 packets and 269 pairs from the within-case packets of both frozen corpora:

- **Real (corpus 1):** Hutchinson, Simpson and Resnick, with 4 real targets and 4 compatible controls.
- **Synthetic (corpus 2):** 21 targets (17 direct, 4 needs-context) and 9 controls.

Unlabelled pairs are unknown and never scored as false positives. Ten labelled corpus-1 pairs sit in no packet, so this pilot could not test them.

The calibration sample is the frozen `data/eval/packet-calibration-v1.json`: 12 packets, 37 pairs and 49 requests.

## Results (corrected verifier; `report-rescored.json`)

| | Pairwise | Packet |
|---|---|---|
| Real review-worthy targets found | 1 / 4 (CW-001) | 1 / 4 (CW-001) |
| Synthetic targets found | 21 / 21 | 21 / 21 |
| Needs-context targets placed as needs context | 0 / 5 | 0 / 5 |
| Compatible controls flagged | 2 / 13 (C08, A05-R1) | 3 / 13 (C08, A05-R1, B01-N1) |
| Valid citations, real / synthetic | 90.8% / 92.2% | 85.1% / 96.5% |
| Abstentions | 19 | 7 |
| Pairs left unanswered | 0 | 0 |
| Repeat runs, same outcome | 22 / 24 | 20 / 24 |

- **Single-pair packets** (12 pairs, the same request text in both arms): the same outcome 11 of 12 times, and the same conflict flag 12 of 12.
- **Grouped packets** (257 pairs): the same outcome 80.5% of the time, and the same conflict flag 89.1%.

Grouping added some errors:

- **Fewer abstentions.** Uncertain pairs became "compatible" (needs_more_context 1 time against 12).
- **One more control flagged.** B01-N1 is a model error: flares and triangles are different devices.
- **More out-of-exchange citations in real testimony:** 23 sides against 6.
- **Less stable large packets.** All three conflict-flag flips on repeat happened in the 10-pair and 5-pair packets.

## Why the real targets were missed

The causes were identical in both arms, so grouping isn't one of them.

| Target | Cause |
|---|---|
| limo-suv | Model reasoning, plus a provisional label (both sides are second-hand). The labelled lines 34:19–24 were outside the passage: missing context. |
| C01 | Segmentation: the decisive "Out of the gate? Yes." is a separate exchange, shown only as context. The packet arm also invented a date to dismiss it, against the prompt. The label is debatable. |
| C02 | Missing context: the strongest line is outside the cited exchange. Abstaining is defensible. |
| CW-001 | Found in both arms (2 of 3 rows in packets). |

Attribution disagreements in real testimony (26 for packets, 27 for pairwise) are mostly verifier artifacts: 15 and 19. These come from an OCR pipe in "A |didn't.", the question-negation rule firing on an attorney's preamble, unstripped labels ("O.J. SIMPSON:"), hedge scope, and the stance a bare "No, he did not." should get. The rest are the model's "qualified" against code's "uncertain". Seven of the eleven in the packet arm are one exchange counted across seven pairs.

## Cost (actual, priced at `2026-10-28`)

| | Requests | USD |
|---|---|---|
| Calibration (12 packets, both arms) | 49 | 0.4753 |
| Pilot: main comparison, new requests | 280 | 2.5775 |
| Pilot: repeatability (6 packets, both arms) | 30 | 0.3096 |
| **Total paid** (equals the pilot database's `llm_calls`) | **359** | **3.3624** |

The comparison itself (both arms, all 269 pairs, repeats excluded) cost **$3.0528**. The 49 calibration replies were reused as identical requests rather than sent again.

| Arm, repeats excluded | Cost | Tokens | Cost per target found (22) |
|---|---|---|---|
| Pairwise | $1.8179 (calibration $0.2741 + pilot $1.5437) | 1,331,394 | $0.0826 |
| Packet | $1.2349 (calibration $0.2012 + pilot $1.0337) | 445,643 | $0.0561 |

Packet adjudication cost **32% less** with 67% fewer tokens. The approved caps were $3 for the calibration and $6 for the pilot.

## Changes made along the way

- **Answer reader.** `server/src/verify/answers.ts` now ignores `A:`, `A.` and bare `A` turn markers, with a regression test in `tests/claims/answers.test.ts`. A read-only audit recomputed all 1,265 stored findings with the old and the new reader: **0 changed** (attribution, score, band and priority), including all 10 reviewed ones. Stored findings come from transcripts whose `A.` markers Layer 1 already strips. The `A:` archive transcripts exist only as evaluation fixtures.
- **118 historical findings** get a different score or band when recomputed today than their stored values. The cause is other code changes since they were scored, not the answer reader. **They were not modified.** Re-scoring them is a separate decision.
- **Packet output limit.** Packets now get the same 5,500-token allowance per pair as pairwise requests. The model doesn't see `max_tokens`, so the limit only prevents cut-off replies.
- **`scripts/packet-benchmark.ts rescore`** re-verifies a finished run's saved outputs without calling the model. Each run's original `report.json` is kept.

## Recommended next steps (not started)

1. **Verifier fixes** (free, no model calls):
   - strip speaker labels in `spoken()`, including `A:` and names like "O.J. SIMPSON:";
   - scope the question-negation rule to the question sentence;
   - handle OCR pipes;
   - scope hedge words to the clause they qualify;
   - include a following bare-answer exchange in the cited lines.
2. **A new prompt version (`packet-v2`),** not tuned to these benchmark cases:
   - define the stance of a bare answer;
   - require needs-context when a conflict rests on inference, hearsay or a lack of knowledge;
   - require comparing concrete details.
3. **Keep packets at 5 to 7 pairs.**
4. **No stronger model yet.** After 1 and 2, a small approved run on the 4 real targets and 4 controls would show whether a semantic gap remains.
