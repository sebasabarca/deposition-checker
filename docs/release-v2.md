# Release: whole-stretch V2 (experimental) and code safeguards, November 5, 2026

A low-cost contradiction-analysis prototype. packet-v1 stays the default contract; whole-stretch V2 is an
experimental option. Nothing here claims validated detection accuracy.

## Branch and commits

`release/v2-experimental` = `feature/whole-stretch-v2`, branched from local `main` 96a6ac8 and fast-forwardable onto it.
`origin/main` is f1b72f9 (local main is not pushed). The commits on top of 96a6ac8:

| Commit | Content |
|---|---|
| d6f988f | 0039/0040 rehearsal on a restored copy; snapshot tools fixed |
| 59f1d84, 930e30d, 17d4802 | stretch-v2 contract, API/CLI/UI behind `ALLOW_STRETCH_V2`, stretch requests load every exchange |
| 16531ef, de7dedb | retrieval trace tool, docs |
| 9d85eb4 | real-model accuracy evaluation ($2.8966) |
| f5541dc | code safeguards, optional diversified retrieval (off), offline replay |
| (release commit) | safeguards shown in the run page, replay demo, smoke-test freeze options, DESIGN note, this file |

## Merge (needs approval; not done)

```sh
git switch main                      # 96a6ac8
git merge --ff-only release/v2-experimental
npm ci && npm ci --prefix client
npm run typecheck && npm run test:full && npm run build --prefix client
git push origin main                 # only when approved: also publishes the unpushed 96a6ac8 commits
```

## Database setup

No new migration on this branch. Main (96a6ac8 and later) already needs 0039 and 0040. The working
`deposition_checker` database is still at 39 migrations. Before running this code against it, follow the rehearsed
steps in `docs/migration-0039-rehearsal.md`: take a snapshot (`scripts/db-snapshot.ts`), run `npm run db:migrate`,
then verify. A fresh install only needs `npm run db:up && npm run db:migrate`.

## Startup

```sh
nvm use 24
npm run db:up && npm run db:migrate
ALLOW_STRETCH_V2=true npm run dev        # API 3001, worker, client 5173
```

Leave `ALLOW_PAID_CALLS` unset (off) for demonstrations. Without `ALLOW_STRETCH_V2=true` the V2 option is hidden and
refused by the API.

## Reproducible demonstration (this machine; no model call)

It uses the recorded real replies under `data/raw/accuracy-eval/`. They are git-ignored and stay on this machine.

```sh
# 1. a disposable database holding the evaluation case (case 19, three Simpson/Resnick sessions, parser r12)
docker exec deposition-checker-db-1 createdb -U deposition -T deposition_checker_rehearsal_v2eval deposition_checker_rehearsal_v2demo
# 2. a stretch-v2 case run answered only by recorded real calls whose request text is byte-identical
npx tsx scripts/replay-case-run.ts --db deposition_checker_rehearsal_v2demo --case 19 --contract stretch-v2 \
  --replies data/raw/accuracy-eval/runs/labelled-stretch-v2-r1
# -> {"requests":1048,"replayed":7,"recordedCostUsd":0.1061}
# 3. the app on that database
DATABASE_URL=postgres://…/deposition_checker_rehearsal_v2demo ALLOW_STRETCH_V2=true npm run dev
```

Register an account, verify it with the link in the dev log, then give it the case:
`update cases set org_id = (select org_id from users where email = '<email>') where id = 19;`. Do this on the
disposable database only.

What the browser shows (checked with headless Chrome; no page errors):
- **Case page:** the "Use the experimental whole-stretch reading" box, unchecked by default, and the run labelled
  "Experimental: whole-stretch reading".
- **Run page `#/case-runs/<id>`:**
  - Status Incomplete, coverage Partial, 92 of 20,012 pairs with a verdict, cost $0.1061 of $1.00.
  - The replay note in full: 7 of 1,048 requests answered by recorded calls, the rest never sent.
- **Potential contradictions:**
  - **CW-001** (developer-labelled review-worthy): direct contradiction, high priority, 85/100. Simpson, Feb 27,
    0:1653–1654 against Resnick, Feb 11, 0:323–325. Both citations verified.
  - An adjacent CW-001 pair: inferential, 54/100.
- **Needs context:**
  - **NC-001** (labelled control): "Both can be true", plus an established alternative.
  - **C07** (labelled control): side B is reported speech.
  - **Next to C02:** the model's own needs_more_context.
  - Each shows the model's original verdict and the code check that moved it.
- **Read in full** opens each deposition in the source viewer at the cited lines, highlighted, with the witness and
  date in the header.

## Video walkthrough script (about 3 minutes)

1. **(0:00)** "Veridict reads deposition testimony and flags potential contradictions. Code checks every citation
   against the stored transcript."
2. **(0:15)** The Simpson-Resnick case: three sessions, two witnesses. Point to the experimental whole-stretch box,
   off by default, and explain that packet-v1 is the default reading.
3. **(0:35)** Open the run. Read out the status, coverage and cost. Say plainly that this run replays 7 recorded
   real model calls: the other requests were never sent, and unread pairs are not cleared.
4. **(1:00)** The direct contradiction: Simpson says Nicole was having a nervous breakdown and he was finding out why;
   Resnick answers "No, he did not" to discussing it. Show "Citation verified" on both sides and the model's reading,
   which is labelled as model output.
5. **(1:30)** Read in full: the source viewer at Simpson 0:1654, then Resnick 0:323–325.
6. **(1:55)** Needs context: the C07 and NC-001 controls. The model called them contradictions; a code check moved
   them (reported speech; "Both can be true"). Nothing is deleted.
7. **(2:30)** Costs and limits: V2 reads a pair for about a third of packet-v1's cost, and detection is not yet
   validated against independent human labels.

## Measured costs (real calls, November 5)

| | packet-v1 | stretch-v2 |
|---|---|---|
| Per request | $0.0246 | $0.0178 |
| Per pair read | $0.00468 | $0.00148 |
| Per flag | $0.0196 | $0.0106 |
| Evaluation total | $1.5262 (2 runs) | $0.6059 (2 runs) + pilot repeat $0.7645 |

Full-case figures are projections only. For case 19 (10,972 kept pairs) that is about $51 for packet-v1 and $16 for
V2 in fast mode, and about half with Economy.

## Prepared, not run: real-model smoke test (cap $4)

Frozen in `data/raw/smoke-v1/` with the experimental retrieval (session2-floor0.85): 35 packet-v1 requests (186
pairs) and 18 stretch-v2 requests (249 pairs), on case 19 and the Hutchinson case. At measured rates one run of each
is about $1.25 and two of each about $2.50. Every request reserves its worst case under the $4 ceiling, so the run
stops before passing it. When authorised:

```sh
K=…  # the API key, from the environment only
for c in packet-v1 stretch-v2; do ANTHROPIC_API_KEY=$K ALLOW_PAID_CALLS=true npx tsx scripts/accuracy-eval.ts run \
  --out data/raw/smoke-v1 --cap 4 --set labelled --contract $c --label r1 --approved-usd 2 --execute \
  --db deposition_checker_rehearsal_v2eval; done
npx tsx scripts/accuracy-eval.ts score --out data/raw/smoke-v1
```

Compare with the preserved baseline (`data/raw/accuracy-eval/score.json`) and the safeguards replay. Pass means:
- no failed or unparseable replies;
- CW-001 and C01 still flagged;
- no newly admitted control published as an unqualified contradiction without a safeguard reason;
- cost within 25% of the projection.

This detects catastrophic regressions only and is not an accuracy claim.

## Known limitations

- Detection accuracy is not validated. The only 3 human-labelled positives were used in development, and V2 was not
  better than packet-v1 on them.
- Retrieval loses most labelled pairs at the per-item cut (11 of 16). The diversified option is off and unproven
  end to end.
- The safeguards were written after seeing these failures. Knowledge-difference and same-occasion questions still
  depend on model reasoning.
- The demonstration run is a replay of 7 recorded calls, not a full-case analysis.
- 57 tests are skipped because local real-data fixture files are absent.
