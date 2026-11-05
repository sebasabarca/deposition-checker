# Evidence correction: procedure

How to correct stored depositions under parser revision 12 (`server/src/evidence/correction.ts`). No model call
is made at any step.

**This needs approval first.** Nothing here has been run on a working or production database. The branch
`feature/safe-evidence-correction` must be reviewed and merged, and migration 0039 applied, before step 1.

**Who runs it:** an operator, from the command line. `scripts/evidence.ts` prints testimony, so run it only
against data you may read.

## Schema changes (migration 0039)

**On `depositions`:**
- `evidence_hold` (text): the correction or rollback that holds the document's evidence;
- `evidence_epoch` (integer, default 0): the count of committed corrections and rollbacks.

**On `analyses` and `case_runs`:** `source_epochs` (jsonb): the epoch of each deposition the job read, recorded
before it first read them.

**New tables:**
- **`evidence_migrations`:** one row per correction, rollback or quarantine.
  - `status`: holding, applied, rolled_back or abandoned.
  - `plan` and `plan_hash`.
  - Document hashes before and after.
  - The backup file.
  - A unique index on (document, plan hash) for applied corrections.
- **`evidence_quarantine`:** one row per quarantined finding, verdict or candidate, with the reason and the prior
  review.

**Triggers:**
- `evidence_guard_*` statement triggers on `lines`, `line_segments`, `exchanges`, `exchange_lines`, `candidates`,
  `verdicts`, `findings`, `statement_cards`, `card_coverage`, `claims`, `claim_tagging`, `fact_units`, `facts` and
  `screening_entries`, for insert, update and delete;
- a row trigger on `depositions`.

While a document is held, they refuse every write except the holder's, with SQLSTATE `VE001`. The API answers 409.

A write from a job that declared the epochs it read (`evidence.read_epochs`) is refused with `VE002` once any of
them is no longer current, at any time. That stops a result computed from evidence corrected since from being
stored.

**Rollback of the migration itself:** drop the triggers, the functions, the two tables and the two columns. No
existing row is changed by 0039.

## Before starting

1. **Take a database snapshot.** The correction's backup covers one document; the snapshot covers everything.

   ```
   npx tsx scripts/db-snapshot.ts dump --db <db> --out data/raw/snapshots/<db>-<date>.dump
   ```

   - The dump is in custom format, and its SHA-256 is written beside it.
   - `pg_dump` is used from your PATH, or else inside the Postgres container named by `PG_DOCKER_CONTAINER`.
   - **Test the snapshot before relying on it**, by restoring it into a new disposable database. `restore` refuses
     any database that already exists, and checks the SHA-256 first:

     ```
     npx tsx scripts/db-snapshot.ts restore --file <dump> --into <db>_rehearsal_restore
     npx tsx scripts/db-snapshot.ts verify --a <db> --b <db>_rehearsal_restore
     ```

     `verify` must report:
     - no table differing;
     - the guard triggers present;
     - every constraint valid;
     - the same ledger, epochs, quarantine and reviews;
     - no broken reference.
2. **Stop analyses and case runs on the case, or let them finish.** A hold is refused while any is unfinished.
   - Fact extraction is a command-line tool: don't run it on the case meanwhile.
   - It refuses held documents anyway, and discards a reading whose source changed while the model read it.
3. **Rehearse on a copy first:**

   ```
   npx tsx scripts/evidence-rehearsal.ts create --template <db> --name <db>_rehearsal_x
   npx tsx scripts/evidence-rehearsal.ts splits --db <db>_rehearsal_x --uploads <uploads dir> --backup data/raw/<dir> --out data/raw/<dir>/splits.json
   npx tsx scripts/evidence-rehearsal.ts findings --db <db>_rehearsal_x --uploads <uploads dir> --backup data/raw/<dir> --out data/raw/<dir>/findings.json
   npx tsx scripts/evidence-rehearsal.ts drop --name <db>_rehearsal_x
   ```

## Correcting one document

1. **Dry run.** It changes nothing and prints the plan and its hash:
   ```
   npx tsx scripts/evidence.ts correct --document-id <id> --expect-lines <page:line,…> --out data/raw/<dir>/<id>-plan.json
   ```
   - **Expected lines:** the page:line of every statement that should change, for the bare-Q fix from
     `tests/fixtures/segments-v2-confirmed.json`. Any other change is `unexpected_difference`.
   - **Review the plan:**
     - changed and regrouped lines;
     - replaced and added exchanges;
     - fact units reset, re-keyed and removed;
     - facts detached;
     - the findings, verdicts and candidates it would quarantine;
     - zero in every integrity check.
2. **Execute** with the same expectation and the plan hash:
   ```
   npx tsx scripts/evidence.ts correct --document-id <id> --execute --plan-hash <hash> --expect-lines <…>
   ```
   Outcomes:
   - `applied`: done. The output names the migration ID and the backup under `data/raw/backups/`.
   - `busy`: unfinished work on the case, or another hold.
   - `plan_changed`: the data changed since the dry run. Run the dry run again and review it.
   - `already_applied`: this plan was applied before. Nothing to do.
   - Anything else: refused. Nothing was changed and the hold was released.
3. **Check:** `npx tsx scripts/evidence.ts integrity --document-id <id>` must print all zeros. A fresh dry run must
   find nothing to change.

## Rolling back

```
npx tsx scripts/evidence.ts rollback --migration <correction id>
```

- **What it restores:** the exact state before the correction (lines, segments, exchanges, members, candidate
  groups, parser version, fact units, facts), proven by the document hash. The quarantine of that correction stops
  applying.
- **When it refuses:** if anything changed the document after the correction. Then restore from the database
  snapshot instead.
- **Known difference:** identity sequences stay advanced, so a later re-correction gives the added exchanges new
  row IDs. The content is identical.

## Recovering from an interruption

Where the interruption happens decides the recovery.

- **Before the hold** (during the dry run, or while taking the hold): nothing was written. Run the dry run again.
- **During the correction transaction:** Postgres rolls the whole transaction back. The tool then releases the
  hold itself, after checking the document is exactly as before, and the ledger marks the hold `abandoned`. If
  the process died instead, the hold remains: see below.
- **After the commit, before the release** (the process died between them): the correction is complete and in the
  ledger as `applied`; only the hold remains. `release` checks the document is exactly what the correction left,
  then releases it.
- **After the release:** nothing to recover. Jobs that read the old evidence are refused when they write (`VE002`)
  and stop with the reason; start them again.
- **Database lost or damaged:** restore the snapshot into a new database, verify it, and point the app at it. Never
  restore over the working database. Jobs recorded in the snapshot resume from their rows. Those that read
  evidence a later correction changed are refused when they write, as above.

### A hold left by a crash

If the process stops between holding and committing, the document stays held. Workers wait, and writes are
refused with `VE001`. Release it:

```
npx tsx scripts/evidence.ts release --migration <hold id>
```

- **A hold that never committed** is released only if the document is exactly as it was before. The ledger marks
  it `abandoned`.
- **A hold that committed** (the process stopped after commit, before releasing) is released only if the document
  is what the correction left.

## Quarantine policies for findings on older parses

Apply these with `npx tsx scripts/evidence.ts quarantine --document-id <id> --reason "<why>" [--findings <ids>]`.
Rows and reviews are never changed.

| Category | How to recognise it | Policy | Automatic? |
|---|---|---|---|
| Superseded parse (`excluded_reason = legacy_parse`, e.g. Hutchinson #32/#33) | excluded | quarantine every finding | yes |
| The current parser reads different text (e.g. Gates OCR #28/#29) | dry run says `refused_by_correction`, text or position changes | quarantine every finding until a versioned re-read | yes |
| Referenced exchanges change (e.g. Marcus Webb #46/#48) | dry run says `needs_versioned_migration` | quarantine every finding: speaker-only changes underneath aren't counted by the refusal | yes |
| Correctable in place | dry run says `dry_run` | correct; the correction quarantines exactly the findings whose evidence changed | yes |
| Stored file not available (synthetic fixtures #10/#11, #14/#15, #40/#41) | dry run: stored file missing | can't be re-read: keep, labelled; regenerate the fixture to re-check | **no** |

Steps that are never automatic:
- **The versioned re-read** for "different text" and "referenced exchanges change". The file is ingested again
  under the current parser as a new document, and the old copy is excluded as `legacy_parse`. A person decides
  this.
- **Revalidation.** A new analysis of the corrected transcript, demo replay or a live run, which is paid and needs
  approval. A person then reviews the new findings. A quarantined finding is never promoted back to current.
