# Migrations 0039 and 0040 on `deposition_checker`: rehearsal (November 5, 2026)

Rehearsed on a restored copy only; `deposition_checker` itself was not migrated or corrected. No model call.
It sets up evidence correction (0039, `docs/evidence-correction.md`) and the economy `reconciling` status (0040).

## Starting point

- `deposition_checker` has 39 migrations (through 0038): 35 depositions, 1,333 findings, 10 human reviews, 86 MB.
- Nothing was running at the time:
  - no unfinished analyses or case runs;
  - no pg-boss job created, active or retrying;
  - no other connection;
  - no dev process.

## Commands and results

**1. Snapshot** (a custom-format dump; the SHA-256 is written beside it):

```
npx tsx scripts/db-snapshot.ts dump --db deposition_checker --out data/raw/snapshots/deposition_checker-2026-11-05-pre0039.dump
```

- 8,254,171 bytes, 403 TOC entries.
- sha256 `896378b004b7a666bbeb3ba0f30bc38085842a3d79032a035d9b3fc2bcec737f`.

**2. Restore** into a new database. The command checks the SHA-256 first and refuses an existing database:

```
npx tsx scripts/db-snapshot.ts restore --file data/raw/snapshots/deposition_checker-2026-11-05-pre0039.dump --into deposition_checker_rehearsal_v2prep
npx tsx scripts/db-snapshot.ts verify --a deposition_checker --b deposition_checker_rehearsal_v2prep
```

The copy matched the source exactly:
- 48 tables, none differing;
- 184 constraints, all valid;
- the same reviews (9 confirmed, 1 needs context, 1,323 unreviewed);
- 35 documents, with no broken references.

**3. Migrate the copy** to 41 migrations, in 33 ms. Afterwards `verify` reports differences only in:
- the migration ledger;
- the two new tables;
- `depositions`, `analyses` and `case_runs`, which gained columns.

Compared on their original columns, those three tables are identical row for row. Every evidence table is unchanged: `lines`, `exchanges`, `candidates`, `verdicts` and `findings`. The new state starts empty:
- all 35 documents at epoch 0 with no hold;
- empty ledger and quarantine;
- 43 guard triggers present.

**4. Correction cycle** on document 70 (O.J. Simpson, parser r10), with the 9 bare-Q lines from `tests/fixtures/segments-v2-confirmed.json`.

1. **Dry run:**
   ```
   npx tsx scripts/evidence.ts correct --document-id 70 --expect-lines 1:262,1:347,1:360,1:466,1:581,1:684,1:971,1:1104,3:1357
   ```
   - Plan hash `88a40b53…6d9`.
   - 5,795 lines, none changed.
   - Exchanges: 9 replaced, 18 added, 2,671 kept with the same ID.
   - 0 findings affected; integrity all zeros before and after.
2. **Execute:**
   ```
   npx tsx scripts/evidence.ts correct --document-id 70 --execute --plan-hash <hash> --expect-lines …
   ```
   - Result: `applied`.
   - The document moves to parser r12 at epoch 1.
   - Integrity is all zeros, and a fresh dry run changes nothing.
3. **Roll back:**
   ```
   npx tsx scripts/evidence.ts rollback --migration correction-70-…
   ```
   - Result: `restored: true`.
   - The document is back on r10 at epoch 2.
   - `verify` against `deposition_checker` again shows every evidence table identical.

## Applying to `deposition_checker` (needs the developer's approval)

1. Stop the app and worker; confirm no unfinished analyses, case runs or pg-boss jobs.
2. Take a fresh snapshot (as in step 1). A dump older than the last write is not a backup.
3. Run `npm run db:migrate`, with `DATABASE_URL` pointing at `deposition_checker`.
4. Check that `select count(*) from drizzle.__drizzle_migrations` returns 41. Then run `verify` against a restore of the new snapshot.

**Rollback.** 0039 and 0040 have no down migration. To undo them:
1. Restore the pre-migration snapshot into a new database.
2. `verify` it against the snapshot's source.
3. Point `DATABASE_URL` at it.

Never restore over the working database. Corrections have their own per-document `rollback` (above).

The demo and pilot databases are at 35 or 36 migrations: each needs its own decision.

## Script fixes found during the rehearsal

- `db-snapshot.ts` and `evidence-rehearsal.ts` didn't load `.env`, unlike `evidence.ts`. They do now.
- `db-snapshot.ts verify` failed on any database from before 0039, because it read the ledger and quarantine tables. Those parts now read as absent, so a pre-migration snapshot can be verified against its source.
