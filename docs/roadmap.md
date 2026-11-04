# Roadmap

Seven milestones. A milestone is complete only when its acceptance criteria pass, measured; otherwise it says what failed. `DESIGN.md` remains the approved architecture; this file tracks the order of work.

| # | Milestone | Status |
|---|---|---|
| 1 | Foundation, repository readiness and agent setup | **Complete** (November 3, 2026): baseline reproduced, misfiled documents excluded, Claude/Codex instructions in place. See `docs/baseline-m1.md` |
| 2 | Packet-versus-pairwise adjudication validation | Next. Handoff: `docs/milestone-2-handoff.md` |
| 3 | Cheap evidence screening | Not started |
| 4 | Independent audit of deferred evidence | Not started |
| 5 | Cost optimization: under $10 per corpus-1-sized case | Not started |
| 6 | Whole-case workflow and lawyer-facing UI | Not started |
| 7 | Deployment and independent end-to-end validation | Not started |

Open decisions carried forward:

- **The paid packet-adjudication pilot** (Milestone 2). About 60 packets, well under $1. It needs the developer's approval and a USD limit.
- **Retrieval criterion 6** (numeric and negation retrieval improves measurably) is only partly met. `F_factual` adds corpus 2's two development cases but nothing on corpus 1. It stays experimental.
