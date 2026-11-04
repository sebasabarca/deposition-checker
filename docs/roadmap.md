# Roadmap

Seven milestones. A milestone is complete only when its acceptance criteria pass, measured; otherwise it says what failed. `DESIGN.md` remains the approved architecture; this file tracks the order of work.

| # | Milestone | Status |
|---|---|---|
| 1 | Foundation, repository readiness and agent setup | **Complete** (November 3, 2026): baseline reproduced, misfiled documents excluded, agent instructions in place (Codex was removed on November 3; development uses Claude Code only). See `docs/baseline-m1.md` |
| 2 | Packet-versus-pairwise adjudication validation | In progress: offline infrastructure built and tested; $3 calibration ($0.48) and $6 pilot ($2.89; 60 packets, 269 pairs, both arms, 30 repeats) run and independently evaluated; see `docs/milestone-2-results.md`. Both arms found 21/21 synthetic but only 1/4 real targets; packets cost 32% less. Real-world detection is not yet validated; next: verifier fixes and a `packet-v2` prompt (not started). Handoff: `docs/milestone-2-handoff.md` |
| 3 | Cheap evidence screening | In preparation: screening contract, deferred-evidence ledger (migration 0035) and offline benchmark built and merged; experimental, not used by normal analyses. No strategy reached more than 2 of 4 real targets in the first 500 of 3,320 packets; all packets project to $59.70, so the under-$10 target is not met. No strategy selected. See `docs/milestone-3-screening.md` |
| 4 | Independent audit of deferred evidence | Not started |
| 5 | Cost optimization: under $10 per corpus-1-sized case | Not started |
| 6 | Whole-case workflow and lawyer-facing UI | Not started |
| 7 | Deployment and independent end-to-end validation | Not started |

Open decisions carried forward:

- **The paid packet-adjudication pilot** (Milestone 2). About 60 packets, well under $1. It needs the developer's approval and a USD limit.
- **Retrieval criterion 6** (numeric and negation retrieval improves measurably) is only partly met. `F_factual` adds corpus 2's two development cases but nothing on corpus 1. It stays experimental.
