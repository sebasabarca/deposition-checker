# Retrieval evaluation protocol, v2 (round 2)

How retrieval variants are measured and compared in round 2. The evaluator is
`server/src/eval/retrievalEval.ts` with `scripts/retrieval-eval.ts`; it needs no database, model or API call. It is
owned by the evaluation role, which never changes retrieval code or its parameters.

## Rules

- **Counts, not percentages.** The real corpus has four targets and the synthetic one 23. Results say "12 of 14",
  never "86% recall", and never a general precision figure.
- **Categories stay apart.** Each labelled pair is sorted by its label's category:

  | Category in the label | Reported as | Target class |
  |---|---|---|
  | `conflict`, `direct` | target | direct (a confirmed direct contradiction) |
  | `conflict_needs_context`, `inferential` | target | needs context (inferential or needing context) |
  | `review_worthy` | target | unclassified (worth a look; the label says no more) |
  | `control`, `no_conflict` | control | none |
  | `exploratory` | exploratory | none |
  | anything else (`insufficient_evidence`, `unknown`, ...) | insufficient evidence/unknown | none |

- **Controls are never false positives or negatives.** A control in a pool is reported as held, apart from targets.
  The false-positive burden counts only candidates that join *no* labelled pair.
- **Labels are read-only.** Existing label files are never edited. A derived file (a held-out set resolved to a new
  corpus version) gets a new versioned name.
- **Held-out pairs stay held out.** If a retrieval change is made after seeing held-out results, those pairs are
  reported as development pairs from then on.
- **Testimony stays under `data/raw/`.** `--out` refuses any other directory, since the unlabelled sample quotes
  testimony. Reports in tracked files carry references and counts only.

## Corpora (round-1 versions)

The round-1 inputs are listed with their SHA-256 in `data/raw/retrieval/round2/baseline-manifest.json` (33 files,
git `56d5fd1`). Verify them before every comparison; never modify them.

| Corpus | Directory | Documents | Items | Labelled pairs |
|---|---|---|---|---|
| 1, real | `data/raw/retrieval/frozen-v1` (fixture `data/eval/evidence-fixtures-v1.json`) | 6 files, 5 sessions (Hutchinson June and September; Simpson day 2 and day 9; Resnick day 9, direct and cross) | 5,620 | design: 3 `review_worthy`, 3 controls. Held-out (`data/eval/simpson-resnick-heldout-v1.json`, against items.json `f2714c57…`): 1 target, 10 controls, 4 exploratory |
| 2, synthetic | `data/raw/retrieval/agent-c/frozen-corpus2-v1` (fixture `data/eval/independent-cross-v1-fixture.json`) | 20 transcripts, each its own session | 458 | 19 `conflict`, 4 `conflict_needs_context`, 25 `no_conflict` |

Known round-1 limits: in corpus 2, four colloquy-format files (A03_witness1, A05_witness2, B03_witness1,
B05_witness2) are read as one or two exchanges, so nine targets have a whole-session side (marked `*`; the other 14
are the "clean" targets). Cover, appearance and errata pages are items in both corpora. Corpus 1 has three
substantive answer groups repeated word for word across the two Hutchinson sessions.

## What is measured

For each pool (a `CandidatePool`, scored in its array order, so a reranked pool is just a reordered file):

- labelled pairs held, by category and target class, with pool rank and per-item rank;
- held counts at per-item budgets (1, 2, 3, 5, 10, 20, 50) and pool-size budgets;
- **review burden**: for each held labelled pair, the candidates reviewed to reach it, how many of those join no
  labelled pair (the false-positive burden) and how many are other labelled pairs; and the reviews needed to reach
  the 1st, 2nd, ... held target;
- **projected adjudication input**, pair by pair: each candidate costs both items' question and answer at 3
  characters per token (rounded up per item) plus a fixed overhead per call, 3,500 tokens by default (the
  `adjudicate-v3` system prompt and JSON schema, about 10,100 characters). `--overhead` changes it; every report
  states the assumption. Tokens to reach each target are reported too;
- **coverage by witness pair and by session pair**: candidates per pair and labelled pairs held per pair;
- path contribution (leave one path out) where the pool can be rebuilt from the paths' neighbours.

For each packet set (`--packets`, Agent 5's `PacketSet`, validated on load):

- for each labelled pair, the packets holding an item of each side (together), the packets that list a joining
  pair explicitly, the first packet that holds it and the projected tokens through that packet, and any of the set's
  own `uncovered` entries that join it;
- packet count (= calls), items and listed pairs per packet (min, median, max, total), distinct items, listed pairs
  that join no labelled pair;
- tokens three ways: the set's stated `inputTokens`, an independent projection (each packet's distinct items plus
  the call overhead), and what adjudicating the same listed pairs one by one would take;
- problems: repeated packet ids, items not in the corpus, listed pairs naming an item outside the packet, listed
  pairs inside one session.

## Establishing a corrected baseline

After the parser fix (Agent 1) and evidence eligibility (Agent 2) are integrated:

1. Verify the round-1 manifest. Re-freeze each corpus into a **new** directory (`frozen-v2`,
   `frozen-corpus2-v2`), with the round-1 freeze settings (depth 300, the same per-item budget). Never overwrite v1.
2. Rebuild every path on the new items, MiniLM included (same model revision and text recipe), and the pools with
   the round-1 settings (`retrieval-pools.ts`, five paths, 5 per item; the adopted triage default).
3. Re-resolve the held-out labels against the new items into a new file (e.g. `simpson-resnick-heldout-v2.json`).
4. Write a manifest of every new input with SHA-256 and the git commit.
5. Run the evaluator on v1 and v2 and record the **corpus difference** (below) next to the results.
6. If possible, also freeze a parser-only corpus (Agent 1 without Agent 2) so the two effects are seen separately.

## Comparing variants

Each variant is compared with the corrected baseline on the **same corpus version**, one change at a time, then
combined:

| Step | Variant |
|---|---|
| 0 | original baseline (round 1, v1 corpora; the reference for what changed) |
| 1 | corrected-parser baseline (parser fix and eligibility; parser only when available) |
| 2 | 1 + specialized discovery (Agent 3's `F_factual` path, fused into the pool) |
| 3 | 1 + local reranking (Agent 4's reordered pool) |
| 4 | 1 + issue grouping (Agent 5's packets built from the step-1 pool) |
| 5 | combined (2 + 3 + 4) |

For every step report: targets held by class (clean and whole-session apart), controls and exploratory pairs held
(apart), per-item budgets, reviews and unlabelled candidates ahead of each target, projected calls and tokens, and
coverage by session pair; for packets, labelled pairs together, calls and tokens. A variant is better only if it
holds every target the reference holds and lowers burden or tokens, or holds more targets at equal or lower cost.
A lost target is named by id, whatever else improved.

## Results across corpus versions

Any comparison of results from different corpus versions states the differences:

- documents added, removed or re-read (by SHA-256 and layout);
- items added, removed and changed (by key and `sourceHash`), per document;
- each labelled pair's mapping: its left and right item keys in each version, pairs newly resolved or no longer
  resolved, and whole-session flags that changed;
- labelled pairs whose category changed (none may change silently; label files are not edited).

Without that statement, numbers from two versions are not compared.

## Further real labels (status at round 2)

No additional independently labelled real pair exists locally beyond those already used:

- `simpson-resnick-cross-v2.json`: 20 pairs; 5 in corpus 1's design benchmark, 15 in the held-out file, 2 excluded
  by the reviewer. It has no `conflict` pair: none is a confirmed direct contradiction.
- `hutchinson-discrepancies-v1.json`: one discrepancy (`limo-suv`), already corpus 1's design target, and a
  development case by its own description.
- `ellison-labels.json`: documents only, no pairs. The Ellison PDFs are local but not in either corpus.
- `review-set-v1.json` (40 pairs: 24 real Ellison, 16 synthetic) and `retrieval-sample-v1.json` (60 Ellison pairs,
  20 source exchanges): every human field is empty, in the JSON and in the review sheets. Model verdicts in them are
  not ground truth, and retrieval must never read the review set.
- `facts-*.json` are fact records and pilot windows, not pairs; `synthetic-cross-v*.json` and
  `independent-cross-v1` are synthetic.

The fastest way to more real evaluation is for the developer to fill the 24 real Ellison rows of the review set and
to freeze a corpus holding the two Ellison depositions; that is a new corpus version under the rules above.

Label gap to keep in mind: corpus 1's fixture calls C01 and C02 `review_worthy` (unclassified), while
`simpson-resnick-cross-v2.json` calls them `conflict_needs_context`. Reports use the fixture's category, as frozen.

## Commands

```
npx tsx scripts/retrieval-eval.ts --frozen <corpus dir> [--benchmark <held-out file>...] \
  [--paths <rankings or neighbours file>...] [--pools <pool file>...] [--packets <packet set>...] \
  [--overhead <tokens>] [--no-frozen-pools] [--out <dir under data/raw>] [--json]
```

Round-1 reproduction (corpus 1, then corpus 2):

```
npx tsx scripts/retrieval-eval.ts --frozen data/raw/retrieval/frozen-v1 --benchmark data/eval/simpson-resnick-heldout-v1.json \
  --paths data/raw/retrieval/agent-a/rankings-E_minilm_qac_s.json --paths data/raw/retrieval/agent-a/neighbours-E_minilm_qac_s.json \
  --pools data/raw/retrieval/lead/pools/pool-c1-add-minilm.json --pools data/raw/retrieval/lead/pools/pool-triaged-c1-default.json --no-frozen-pools
npx tsx scripts/retrieval-eval.ts --frozen data/raw/retrieval/agent-c/frozen-corpus2-v1 \
  --paths data/raw/retrieval/lead/corpus2-minilm/rankings-E_minilm_qac_s.json --paths data/raw/retrieval/lead/corpus2-minilm/neighbours-E_minilm_qac_s.json \
  --pools data/raw/retrieval/lead/pools/pool-c2-add-minilm.json --pools data/raw/retrieval/lead/pools/pool-triaged-c2-default.json --no-frozen-pools
```
