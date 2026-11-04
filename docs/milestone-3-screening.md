# Milestone 3 preparation: cheap evidence screening (November 3, 2026)

**Status: preparation only. Milestone 3 is not complete.** This builds the screening contract, the deferred-evidence ledger and an offline benchmark, and measures a baseline. Nothing here is wired into production adjudication, and the default analysis method is unchanged. No strategy or budget is selected: that waits for the Milestone 2 pilot results and the Milestone 4 audit of deferred evidence. No paid model call was made. The worktree `.env` has no API key and `ALLOW_PAID_CALLS=false`.

Worktree `../deposition-checker-m3`, branch `m3-screening`, from `e48145b`, uncommitted. Test database `deposition_checker_m3_test`.

## What was built

| Piece | File | What it does |
|---|---|---|
| Contract | `server/src/screen/contract.ts` | `screen-contract-v1`. Each packet gets one `ScreeningResult`: status `prioritized`, `deferred` or `consolidated`; a rank; `priority`, an ordering key and not a probability; named signals (a strict schema rejects keys that look like a verdict, confidence or probability); a reason; the strategy and its version; sessions, witnesses and items with `sourceHash`; the original pool pairs; `consolidatedInto`; and an adjudication state kept apart from the screening status. `accountFor()` checks that every pool pair ends in exactly one packet or in `uncovered`. |
| Strategies | `server/src/screen/strategies.ts` | `baseline` (grouping order), `fused`, `minilm`, `deterministic` and `coverage`, plus optional `consolidate`. Pure functions. Weights were fixed before the first run. |
| Ledger | `server/src/screen/ledger.ts`, tables `screening_runs` and `screening_entries` (migration `0035_screening_ledger`) | Records a run and its results, rejecting the whole run if any result is invalid. `claimNext` (row locking, `SKIP LOCKED`), `markAdjudicated` (allowed only from `in_progress`; packets consolidated into it follow it), `markFailed`/`retryFailed`, `releaseInProgress` (after a crashed worker), `extendBudget` (promotes deferred packets in rank order, never lowers the budget), `ledgerSummary`, `entryEvidence` and `staleEntries` (the evidence's source hash changed or the item disappeared). No entry is ever deleted. |
| Benchmark | `server/src/eval/screeningBenchmark.ts`, `scripts/screening-benchmark.ts` | Screens the frozen within-case packet sets of corpus 1 (real) and corpus 2 (synthetic) with every strategy. Checks accounting and provenance, and reports at each budget: labelled pairs reached, controls, session-pair and witness coverage, repeated passage reads, tokens and projected cost. It records the inputs' SHA-256 before and after each run and fails if any changed. |

The ledger was written by an implementer subagent in its own worktree and reviewed by the lead. The lead added `releaseInProgress`. An evaluator subagent checked the work independently: all 7 acceptance criteria passed. It found four defects, fixed afterwards:

1. A label split between a packet and a packet folded into it was not counted as read. It is now counted.
2. The ledger could store a run whose pairs don't add up to the pool. `recordScreening` now refuses one.
3. Deleting a run would have deleted its entries. The foreign key is now `ON DELETE restrict`.
4. Deferred reasons are now counted by kind, not by their full packet-specific text.

After the first fix, the consolidated runs reach one or two more labels, mostly synthetic, controls included. No corpus-1 target rank changed.

### How the strategies work

- **deterministic** scores each listed pair as the sum of four signals, each scaled to 0..1:
  - the share of retrieval paths that found the pair;
  - half weight: the share of paths that found it in both directions;
  - rare features the two passages share, capped at 4;
  - the numeric and polarity disagreement score from `retrieve/factual.ts`.

  A packet's priority is its best pair. No signal ever excludes a packet. A missing signal only lowers its rank.
- **coverage** takes the deterministic priorities and takes turns between session pairs, one packet each per round, so no session pair waits behind another's whole queue. Within a session pair, it prefers packets whose passages no earlier packet holds.
- **consolidate** folds a later packet into an earlier open packet only when both packets cover the same sessions, the later packet shares at least half of the smaller packet's passages, and the combined packet still fits the bounds (8 passages, 6,000 tokens). Shared participants alone never trigger a merge. The folded packet keeps its own id and pairs, and the ledger marks it adjudicated when its target is.

## Measured baseline

Inputs are the Milestone 1 packet sets (`F_factual` pool, triaged, within one case, default grouping):

- **Corpus 1:** 5,552 items, 13,559 pool pairs, 3,320 packets listing 13,557 pairs. The other 2 pairs are uncovered, each with a reason.
- **Corpus 2:** 529 items, 1,214 pairs, 345 packets.

Screening runs locally, with no model:

- 0.4 s per strategy on corpus 1 (1.2 s for `coverage`);
- 0.31 GB peak for the whole benchmark;
- 6 s for the whole benchmark;
- $0 screening cost.

Accounting and reference problems were 0 in every run.

### Corpus 1 (real): first packet rank at which each review-worthy pair's two sides are read together

| Strategy | limo-suv | C01 | C02 | CW-001 | Reached at 300 | Reached at 500 | Projected cost at 500 |
|---|---|---|---|---|---|---|---|
| baseline (no screening) | 2049 | 2645 | 1241 | 119 | 1/4 | 1/4 | $10.95 |
| fused | 563 | 1722 | 1070 | 260 | 1/4 | 1/4 | $13.21 |
| minilm | 1221 | 1541 | 133 | 15 | 2/4 | 2/4 | $15.53 |
| deterministic | 217 | 1469 | 748 | 285 | 2/4 | 2/4 | $12.93 |
| deterministic+consolidate | 214 | 1203 | 715 | 281 | 2/4 | 2/4 | $14.05 |
| coverage | 1045 | 1833 | 154 | 73 | 2/4 | 2/4 | $9.51 |
| coverage+consolidate | 986 | 1004 | 154 | 73 | 2/4 | 2/4 | $11.86 |

With 4 targets this is anecdotal, not a measured recall. Reading the targets' ranks:

- **No strategy reaches more than 2 of the 4 within 500 packets.**
- **C01 never ranks earlier than about 1,000 in any strategy.**
- Reaching all four takes about half the queue: 1,327 to 1,660 packets for minilm, deterministic and either consolidated order. Fused and coverage need more than 1,660, and baseline needs all 3,320.

Corpus 1's compatible controls reached by 500 packets were 0 to 2 of 13, but 9 controls are in no packet at all, so this says little.

**Session coverage at 500 packets** (prioritized of total, per session pair):

- **deterministic** concentrates: Hutchinson gets 242 of 367, Simpson day 2 + day 9 gets 150 of 1,726, and Resnick + Simpson day 2 gets 31 of 561.
- **coverage** spreads evenly: about 117 per session pair, and all 33 three-session packets.

All five sessions get some packets under every strategy.

### Corpus 2 (synthetic, 23 targets, 25 controls): targets reached

| Strategy | 9% (31 packets) | 15% (52) | 30% (104) | 50% (173) |
|---|---|---|---|---|
| baseline | 9 | 12 | 20 | 20 |
| fused | 5 | 11 | 14 | 14 |
| minilm | 3 | 6 | 10 | 16 |
| deterministic | 7 | 11 | 19 | 19 |
| coverage | 9 | 16 | 17 | 20 |

On corpus 2, screening does not clearly beat grouping's own order. In that order, each synthetic case's packets come together, so the order is already almost a coverage order. Controls rise about as fast as targets under every strategy: on 48 labels, no signal separates contradiction from compatible testimony. MiniLM similarity is the weakest single signal here.

### Cost

Projected cost uses the Milestone 2 calibration's **measured** usage (12 packet requests, 37 listed pairs, 0 retries):

- about 377 output tokens per listed pair;
- a 3,518-token cached prefix;
- passage tokens at 3 characters per token;
- a 5% retry allowance (assumed);
- Sonnet 5.5 prices from `costs/pricing.ts`.

| Corpus 1 | Packets | Listed pairs | Projected |
|---|---|---|---|
| Everything | 3,320 | 13,557 | **$59.70** ($83 uncached) |
| 500, coverage | 500 | 2,123 | $9.51 |
| 500, deterministic | 500 | 2,824 | $12.93 |
| 300, coverage | 300 | 1,383 | $6.18 |

- **Output per listed pair, not the packet count, drives the cost.** About 90% of the full-case projection is output (13,557 pairs × 377 tokens ≈ $54 of $59.70). The earlier $40 estimate counted input only.
- **Consolidation saves almost nothing.** It cuts calls by about 20% (3,320 to 2,662), but every pair still needs its own verdict: the full case projects $59.25 instead of $59.70.
- **At 500 packets the cost fits under $10 only with coverage ordering**, which picks smaller packets. That reads 2,123 of 13,557 pairs (16%) and leaves 84% deferred.
- **This does not achieve the $10 target**, and none of this is analysis of the deferred evidence.

These figures rest on a 12-packet calibration. Replace them with the full pilot's measured usage once it is reviewed.

## What this does and does not show

- **Shown:** screening can order packets, record every deferral with its reason, and resume without repeating work. Every original pair stays auditable. The benchmark is reproducible: rerunning it gives identical numbers apart from runtime.
- **Not shown:** that any cheap signal reliably brings important contradictions forward. On real data, the best orders still defer half the known targets at a 300 to 500 packet budget. Retrieval rank and similarity measure topical closeness, not inconsistency.
- **Not done:** no threshold was tuned, and no strategy was chosen. Making a choice from these 4 targets would overfit them.

## Remaining risks

1. **With only four real targets, these results are anecdotes.** Any choice of strategy needs the Milestone 4 audit of deferred packets, or more labelled real pairs.
2. **Output tokens per pair dominate cost.** Cutting cost needs fewer listed pairs per packet, or a shorter verdict format when a pair is not comparable (Milestone 5). Fewer packets alone won't do it.
3. **A crashed worker can cause a repeated paid call.** `releaseInProgress` returns claimed packets to the queue. If a crash happens after a paid reply but before `markAdjudicated`, that packet is paid for twice. Linking `adjudication_ref` to `adjudication_requests` would close this.
4. **Ledger runs aren't tied to an analysis yet.** They are keyed by frozen item keys, not stored exchange IDs. Production needs `analysis_id` and Milestone 2's key-to-line loader (`adjudicate/packetLoad.ts`).
5. **Migration 0035 was generated on a branch without Milestone 2's uncommitted changes.** If Milestone 2 adds a migration first, regenerate this one.
6. **This worktree has no real-fixture data.** In the full suite, 59 tests that need `data/raw` fixtures were skipped (1,134 passed, 0 failed).

## Integration plan (after the Milestone 2 review)

1. **Take Milestone 2's verdict.** Packet versus pairwise decides the unit that screening orders. If pairwise wins, screen pairs with the same contract: `packetId` becomes a pair id.
2. **Recalibrate cost** with the full pilot's measured output per pair and retry rate. Update `COST_ASSUMPTIONS`.
3. **Select nothing yet.** In Milestone 4, audit a fair random sample of deferred packets for each candidate strategy with the strong model, within an approved USD limit. Measure what each strategy defers, not just the 4 known targets.
4. **Wire in the ledger:**
   - add `analysis_id` to `screening_runs`;
   - build entries from stored exchanges through `packetLoad.ts`;
   - have the adjudication job take work with `claimNext` and record `adjudication_ref` as the `adjudication_requests` id;
   - show the deferred count and its reasons in the report ("N packets, M pairs not yet reviewed"), never as "no contradiction".
5. **Make default changes only with approval** and an update to `DESIGN.md`.

## Commands

- `npx tsx scripts/screening-benchmark.ts --raw <main repo>/data/raw [--out data/raw/screening/<name>]`: the offline benchmark described above. No model, API or database call. Output is git-ignored, because it names testimony items.
- Tests: `npx vitest run tests/screen tests/db/screeningLedger.test.ts`.

## Doc updates to apply at integration

These were not applied in this worktree, to avoid conflicts with Milestone 2's uncommitted edits to the same files.

- `docs/architecture.md`: add `screen/` (contract, strategies, ledger; pure apart from `ledger.ts`; never calls a model), `eval/screeningBenchmark.ts` and `scripts/screening-benchmark.ts`.
- `docs/commands.md`: the benchmark command above.
- `docs/roadmap.md`: Milestone 3 becomes "In preparation: contract, ledger and offline baseline built (see `docs/milestone-3-screening.md`); no strategy selected".
- `tests/db/database.ts` `emptyTables`: add `screening_entries, screening_runs` if other tests ever write them. Today only the ledger test does, and it empties them itself.
