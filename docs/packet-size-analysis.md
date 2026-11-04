# Packet size and adjudication errors

Question: when several candidate pairs are adjudicated together in one request (a "packet"), do errors rise
as the packet gets bigger? And how big may a packet safely be?

Short answer: on the saved runs, **errors do not rise with packet size once pair difficulty is held fixed**,
up to 8 pairs per packet. Above 8 pairs, the packet's verdicts **agree less often with the same pairs judged
one at a time**, but that rests on 4 packets and is driven mostly by one of them. A conservative limit is
**8 pairs per packet**, with input below about 9,000 tokens (the largest packet tested). This is a limit inside
the tested range, not proof that larger packets are harmful.

Everything here comes from saved paid replies. No model was called again.

## Data

| Run | Prompt | Packet requests | Pairs | Notes |
|---|---|---|---|---|
| `pilot-run` | packet-v1 | 60 | 269 | Includes the calibration run's 49 replies, so `calibration-run` is not added on top. 6 packets (24 pairs) were also sent a second time ("repeats"); those are kept out of the main tables. |
| `v2-eval` | packet-v2 | 21 | 78 | Each passage also shows its adjacent exchanges. 4 pairs have no comparison (3 missing packet verdicts, 1 failed pairwise request). |

Both runs sent every pair twice: once inside its packet ("packet arm") and once alone ("pairwise arm"), with
the same evidence and the same prompt. Packet ids repeat across corpora, so every key is corpus plus packet id.

The files are under `data/raw/packet-pilot/` (git-ignored, they quote testimony). The script's output,
`data/raw/packet-pilot/size-analysis/size-analysis.json`, holds only counts and item keys.

## Method

`scripts/packet-size-analysis.ts` (tests: `tests/eval/packetSizeAnalysis.test.ts`) reads `pairs.json` and
`replies.json` of each run. No database, model or API call.

```
npx tsx scripts/packet-size-analysis.ts --root /path/to/data/raw/packet-pilot
```

Per packet request: pairs requested, distinct passages, input size (input + cache read + cache write tokens),
output tokens and stop reason. All 81 packet requests stopped with `end_turn`: none was cut off. Input ranged
from 4,235 to 8,780 tokens, output up to 4,254 tokens, at most 8 distinct passages per packet.

**Adjacent exchanges shown (v2):** not derivable. The request text was not saved, and adjacency is loaded from the
pilot database. Their size is inside the input tokens. What is known is how often a side's citation used one:
48 sides in the packet arm against 20 in the pairwise arm.

Per pair, these error indicators, each for both arms:

- **unanswered**: status missing, duplicate or request failed;
- **invalid citation**: a validation failure about a source (wrong reference, unsupported), both sides citing
  the same passage, or a substantive outcome with no phrase;
- **consistency issue**: `pairs.json` does not store these, so they are re-derived from the saved verdict
  with the same rules as `server/src/verify/packet.ts` (v1 and v2 rules). Counted per pair, so the totals are
  lower than the report's per-issue counts (v1: 1 and 2 pairs against 2 and 2 issues; v2: 2 and 0 pairs against 4 and 0);
- **attribution disagreement**: code's attribution reading disagrees with the model's on either side;
- **any error**: one or more of the above.

And between the arms, on pairs both arms answered:

- **outcome differs**: the two verdicts give different outcomes;
- **conflict flag differs**: one calls it a conflict (direct or inferential), the other does not.

There is no ground truth here for most pairs. "Outcome differs" measures instability, not which arm is right.

**Paired design.** Each pair's packet result is compared with its own pairwise result. Big packets tend to hold
hard pairs (they form around crowded issues), so a plain "errors by packet size" chart mixes packet effects with
pair difficulty. The pairwise arm shows how hard those same pairs are without packing. The difference
(packet minus pairwise) is the packing effect. The discordant counts (errors only in the packet arm, errors only
in the pairwise arm) give an exact McNemar p-value per bin.

Per request, Spearman rank correlations against pairs per packet and input tokens, for the packet arm's
error rate, the pairwise arm's on the same pairs, their difference and the outcome disagreement.

## Results: packet-v1 (`pilot-run`)

By pairs per packet ("any error" counts, rates in brackets; packet-only / pairwise-only discordant pairs):

| Pairs | Requests | Pairs | Packet errors | Pairwise errors | Difference | Discordant | McNemar p | Outcome differs | Conflict flag differs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 12 | 12 | 1 (8.3%) | 1 (8.3%) | 0 | 0/0 | 1 | 1/12 | 0/12 |
| 2-3 | 14 | 36 | 3 (8.3%) | 4 (11.1%) | -2.8 pts | 2/3 | 1 | 7/36 | 4/36 |
| 4-5 | 10 | 44 | 4 (9.1%) | 3 (6.8%) | +2.3 pts | 3/2 | 1 | 6/44 | 3/44 |
| 6-8 | 20 | 136 | 41 (30.1%) | 33 (24.3%) | +5.9 pts | 21/13 | 0.23 | 23/136 | 11/136 |
| 9+ | 4 | 41 | 3 (7.3%) | 5 (12.2%) | -4.9 pts | 3/5 | 0.73 | 14/41 | 10/41 |

The errors by kind (packet / pairwise): invalid citation 27 / 24, attribution 25 / 24, consistency 1 / 2,
unanswered 0 / 0.

By input tokens:

| Input tokens | Requests | Pairs | Packet errors | Pairwise errors | Difference | McNemar p | Outcome differs |
|---|---|---|---|---|---|---|---|
| < 5,000 | 17 | 22 | 2 | 3 | -4.5 pts | 1 | 5/22 |
| 5,000-5,999 | 17 | 66 | 7 | 4 | +4.5 pts | 0.38 | 13/66 |
| 6,000-6,999 | 12 | 85 | 15 | 18 | -3.5 pts | 0.69 | 14/85 |
| 7,000+ | 14 | 96 | 28 | 21 | +7.3 pts | 0.17 | 19/96 |

Spearman, per request (60 requests):

| Measure | vs pairs | vs input tokens |
|---|---|---|
| Packet error rate | 0.41 | 0.48 |
| Pairwise error rate, same pairs | 0.37 | 0.35 |
| Packet minus pairwise | 0.05 | 0.20 |
| Outcome disagreement | 0.31 | 0.21 |

Pairs and input tokens correlate at 0.86, so the two sizes cannot be separated.

## Results: packet-v2 (`v2-eval`)

| Pairs | Requests | Pairs | Packet errors | Pairwise errors | Difference | Discordant | McNemar p | Outcome differs | Conflict flag differs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 6 | 6 | 0 | 0 | 0 | 0/0 | 1 | 0/6 | 0/6 |
| 2-3 | 6 | 15 | 2 | 2 | 0 | 1/1 | 1 | 3/15 | 1/15 |
| 4-5 | 3 | 13 | 4 | 0 | +30.8 pts | 4/0 | 0.13 | 2/10 | 1/10 |
| 6-8 | 5 | 34 | 9 | 13 | -11.8 pts | 5/9 | 0.42 | 6/33 | 6/33 |
| 9+ | 1 | 10 | 2 | 2 | 0 | 0/0 | 1 | 5/10 | 3/10 |

By kind (packet / pairwise): invalid citation 10 / 6, attribution 3 / 10, unanswered 3 / 1, consistency 2 / 0.
The 4-5 bin's excess is one 4-pair packet that answered only 1 of its 4 pairs (3 missing verdicts, a
complete reply with `end_turn`): a packet-arm failure, but not in a large packet.

By input tokens: < 5,000: 0 vs 1 error (12 pairs); 5,000-5,999: 5 vs 1 (14); 6,000-6,999: 8 vs 13 (42);
7,000+: 4 vs 2 (10).

Spearman (21 requests): packet error rate 0.71 vs pairs, pairwise on the same pairs 0.60, difference -0.12,
outcome disagreement 0.49. Pairs vs input tokens 0.90.

## What the numbers say

1. **Raw error rates do rise with size** (v1 rho 0.41, v2 0.71), **but so do the pairwise arm's on the same
   pairs** (0.37, 0.60). The packing effect, packet minus pairwise, is flat (0.05 and -0.12). That points to
   pair difficulty, not packet size: the pairs that end up in large packets are harder in either arm. In v1,
   the 6-8 bin holds most of the errors in both arms (41 and 33 of 136 pairs).
2. **No bin shows a significant packing effect on errors.** The largest packet excess (v1 6-8: +5.9 points,
   21 packet-only against 13 pairwise-only discordant pairs) has p = 0.23.
3. **Agreement with the one-at-a-time verdict falls above 8 pairs** in v1: outcome differs on 14 of 41 pairs
   in 9+ packets against 37 of 228 in 1-8 (34% against 16%, Fisher p = 0.015), and the conflict flag on
   10 of 41 against 18 of 228 (24% against 8%, p = 0.004). The 9+ bin is only 4 packets, and one,
   `c1/issue-118` (10 pairs), accounts for 5 of the outcome changes and 5 of the conflict flips. Without it
   the conflict flip is 5 of 31 against 18 of 228 (p = 0.17), and the outcome change 9 of 31 (p = 0.13).
   v2 has one 9+ packet: the same `issue-118`, again 5 of 10 outcomes differ.
4. **Repeats** (v1 only, the same requests sent again): packet outcomes changed on 4 of 24 pairs, pairwise on 2
   of 24. By packet, `c1/issue-118` changed 3 of 10 packet outcomes and 0 of 10 pairwise; the other five
   repeated packets (1-5 pairs) changed 1 packet and 2 pairwise outcomes. So run-to-run noise alone moves
   roughly 8-17% of outcomes, about the 16% disagreement seen in 1-8 pair packets, while the 10-pair
   packet was unstable in its own right. One packet is an anecdote, not a trend.
5. **Packet-v2 is too small to judge** by size: 21 packets, one at 9+, three at 4-5.

## Correlation, not causation

The packets were not randomised by size. They were formed by issue clustering, so:

- **Size goes with difficulty.** Big packets gather around crowded issues and popular passages; the paired
  design controls this for the error indicators, not for disagreement, which has no reference answer.
- **Large "star" packets** centre on one popular item, so many of their pairs share one passage; one hard
  passage can raise every pair's error together. Pairs within a packet are not independent, which makes the
  p-values above optimistic.
- **Size and input tokens move together** (rho 0.86 and 0.90): any effect cannot be pinned on pairs rather
  than tokens.
- **Few large packets:** 4 in v1 and 1 in v2 have 9 or more pairs, and `issue-118` is in both runs.
- **The corpora differ** (c1, c2), and the mix by size differs between them.
- **v2 has fewer packets** and a different prompt, so it neither confirms nor refutes v1.

A causal answer needs the same pairs sent in packets of different sizes (for example, the large packets
split into halves and re-sent, with repeats), which these saved runs cannot provide.

## Proposal

- **Maximum 8 pairs per packet.** Up to 8, the paired comparison finds no packing effect on any error
  indicator, with 136 v1 pairs in 6-8 packets. Above 8, agreement with the one-at-a-time verdicts falls, on too
  little evidence to call harmful but enough to avoid.
- **Keep input under about 9,000 tokens** (largest tested: 8,780), as a guard rather than a measured limit: the
  token bins show no effect of their own, and larger requests are simply untested.
- **Evidence is insufficient** to allow more than 8 pairs, and to set a tighter token limit. With at most 136 pairs a bin, these runs could
  miss a packing effect of roughly 10 points.

Splitting a large packet would cost a few more requests and repeated passage text; the pilot reports' cost
figures, not this analysis, should price that.
