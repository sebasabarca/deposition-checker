# Milestone 4 design: independent evaluation and audit of deferred evidence

Status: design only (November 4, 2026). Nothing here is implemented, labelled or paid for. It needs the developer's approval before any step starts.

## Purpose

Estimate how well the whole pipeline finds review-worthy discrepancies in real testimony it was never developed on, and attribute every miss to the stage that caused it.

Development so far rests on 4 real targets that every prompt and ranking choice has seen. They can't measure real-world detection, and Milestones 2 to 3 found 1–2 of them at best. This evaluation must not be used to tune a prompt or ranking to those four.

## Principles

1. **Held-out testimony.** The evaluation documents are not Hutchinson, Simpson or Resnick, and not the synthetic corpora. The 4 known targets are excluded from every score.
2. **Labels before system outputs.** Labellers never see the system's candidates, ranks, screening decisions, verdicts or strata. Labels are sealed with SHA-256 before any system run is scored, following `data/eval/independent-cross-v1/provenance/seal-*.json`.
3. **Frozen configuration.** The configuration is fixed before the labels are unsealed:
   - retrieval paths and pools;
   - the screening strategy (Milestone 3, `screen-v1`), the deferred-evidence budget and the ledger;
   - the adjudication contract (`packet-v1` default; v2 and v3 optional arms) and the model and effort;
   - the verifier version (`verify-2026-11-04`).

   No change is allowed after unsealing. A bug found then is recorded and fixed for a later round, not this one.
4. **Pre-registered analysis.** The metrics and tables below are fixed before the run. Anything else is reported as exploratory.

## Evaluation corpus

- **Documents.** Real, public-record depositions with at least two sessions of one witness, or overlapping testimony from two witnesses on the same events, across several cases and factual domains. Candidates:
  - stored public documents not used in adjudication development (U.S. v. Oracle and U.S. v. Microsoft);
  - new public-record transcripts, found with the `real-world-inventory.md` method, where a judicial document identifies a testimony conflict, which gives an outside anchor.

  Each document is recorded with its source, SHA-256 and licence status. Transcripts stay git-ignored under `data/raw/`; only the labels, which quote short excerpts, are tracked.
- **Size.** About 6–8 witness session pairs, with at least 3 witnesses and 3 cases, sized so that labelling stays feasible.

## Two label sets

### A. Exhaustive reference, for retrieval and screening recall

For each session pair, two independent labellers read both sessions and list every discrepancy a lawyer would want to review, each with its page:line on both sides, its class and its issue.

- **Classes:** direct, inferential or review-worthy, clarification or correction, secondhand or uncertain, needs context.
- This is the only way to measure what retrieval never surfaced.
- Bounded to the chosen session pairs (or bounded sections of them), because exhaustive reading is expensive.

### B. Stratified candidate sample, for adjudication and screening calibration

Drawn from the frozen pipeline's own candidate pool and screening ledger for the same documents, by a seeded script, about 120 pairs:

| Stratum | Pairs | Why |
|---|---|---|
| High-ranked (screened in, top of the order) | 30 | what the lawyer sees first |
| Low-ranked (screened in, bottom of the order) | 25 | whether the order carries signal |
| Deferred (screened out under the budget, kept in the ledger) | 30 | the Milestone 4 audit question: what deferral loses |
| Consolidated (merged into another packet's issue) | 10 | whether consolidation hides issues |
| Random within-case cross-session pairs (not necessarily retrieved) | 25 | the base rate of compatible testimony, and a retrieval-recall check |

Coverage requirements:

- different witnesses, sessions and factual issues in every stratum;
- both compatible and potentially contradictory testimony, which the random stratum and the controls ensure.

Labellers see only the two passages and their adjacent exchanges, in random order, with no stratum, rank or system output. Each pair is labelled with the same classes as set A, or "compatible".

### Labellers

- **Preferred:** two lawyers or trained reviewers working independently, with a third person adjudicating disagreements.
- **If that isn't available:** two independent Claude labelling agents, given only the passages and the label guide and no access to any system output, plus the developer adjudicating disagreements. This weakens independence, so it must be reported as such.
- **Agreement:** Cohen's kappa on set B, and the overlap of discrepancy lists on set A, reported before anything is scored.

## Error attribution protocol

Each labelled discrepancy (from set A, plus the targets in set B) is traced through the pipeline. It gets the first stage that lost it, using records the pipeline already keeps.

| Code | Stage | How it is decided |
|---|---|---|
| R | Retrieval miss | Neither candidate pair joining the two labelled sides is in the pool (`retrieval-eval.ts` pool holding; `F_factual` and MiniLM paths as frozen) |
| S | Screening miss | The pair is in the pool, but deferred or below the budget in the screening run (`screening_entries` state, ledger) |
| E | Evidence incomplete | The pair was adjudicated, but the labelled lines were not shown (`missedCause: evidence_incomplete`, extended from frozen items to the label's own page:line) |
| A | Adjudication misinterpretation | The evidence was shown in full, and the outcome contradicts the label (`missedCause: interpretation`) |
| C | Invalid citation or attribution | A conflict outcome whose citations fail (`diagnosis`) or whose attribution is contradicted |
| U | Appropriate uncertainty | needs more context or insufficient evidence on a label that needs context or is only review-worthy. Not counted as a detection |
| D | Detected | A correct contradiction, or surfaced for review, with valid citations |

For controls: correct, surfaced for review, or **incorrect contradiction**.

## Pre-registered metrics

- **Funnel recall** on set A: share surviving retrieval, then screening, then evidence, then adjudication, with each stage's own losses (R, S, E, A, C) and Wilson 95% intervals.
- **Set B, per stratum:** the review-oriented categories (`scoreArm` review outcomes) and exact match (`EXPECTED`), for the default `packet-v1` and any optional arm, packet and one-pair reported separately.
- **Deferred-evidence audit:** the rate of review-worthy discrepancies among deferred pairs, against high-ranked and random pairs. This is the main Milestone 4 question.
- **Controls:** the incorrect-contradiction rate in each stratum.
- **Cost:** actual tokens and cost per detected discrepancy, from `llm_calls`.
- **Uncertainty:** with about 120 pairs, intervals stay wide. A difference smaller than the run-to-run variation measured in Milestone 2.5 (about 3 in 17 grouped outcomes) is not a finding.

## Planned steps (each needs approval; none started)

1. Select and record the documents (provenance, SHA-256, licence), and ingest them into a dedicated evaluation database, not the demo database.
2. Freeze the configuration, and run retrieval and screening. These are free: no model.
3. Draw set B with a seeded script, export blinded passages, and write the label guide.
4. Label sets A and B independently, adjudicate disagreements, seal the labels and report agreement.
5. Adjudicate set B (and the pairs needed for set A's funnel) under a paid cap. At v1-pilot rates, about 150 pairs in both arms is roughly $2–3; to be confirmed with `--plan` before approval.
6. Score with the protocol above, attribute every miss, and publish the results with their limits.

## Out of scope

Prompt or ranking changes, retrieval redesign, and UI work. Any of these comes after the results, as a new versioned experiment evaluated on fresh held-out data.
