# Deposition Checker

Finds potential contradictions in a witness's sworn testimony across deposition sessions, and shows a lawyer both passages side by side, verbatim, at their page:line.

- **Retrieval.** Two retrieval paths find candidate pairs of exchanges: structured claims and full-text search.
- **Classification.** Claude Sonnet classifies each pair as direct, inferential, a likely false positive, or insufficient evidence.
- **Verification and scoring.** Code checks every citation against the stored transcript, reads who actually said what, and scores the assessment with a fixed, published rubric. Claude never returns a score.
- **Where findings go.** Findings whose citations can't be verified aren't scored: they go to a "Needs your review" section.

## Setup

The full guide, including what has and hasn't been tested on a fresh machine, is `docs/setup.md`.

**Requirements:**
- Node.js 22.12 or newer (`.nvmrc` selects 24);
- Docker (for Postgres 16);
- an Anthropic API key, only for live analyses.

```bash
cp .env.example .env        # fill in the values below
npm install                 # also installs client/
npm run db:up               # Postgres in Docker, with a separate _test database
npm run db:migrate          # apply drizzle/ migrations to DATABASE_URL
npm run dev                 # API (3001), worker, and the app (http://localhost:5173)
```

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | The development database. |
| `TEST_DATABASE_URL` | A separate database for tests. Its name must end in `_test`, because the tests empty it. |
| `ANTHROPIC_API_KEY` | Read only by the server and worker; it never reaches the browser. |
| `ALLOW_PAID_CALLS` | Must be `true` for a live analysis to call Claude. Leave it unset in development and tests: demo analyses never call a model. |

## Using it

1. **Create a case** (Cases → New case).
2. **Upload deposition PDFs** on the case page: a text-based transcript, up to 50 MB, with the witness and, optionally, the session date. The worker reads each file in the background, and the table updates as it does. Re-uploading the same file returns the existing session instead of processing it twice.
3. **Compare two sessions:** choose two Ready sessions of the same witness.
   - **Demo:** no model calls, no cost. It replays stored Claude assessments where they exist, labelled as such, and counts the pairs that have none.
   - **Live:** calls Claude for each selected pair under a budget (default $3). It stops before any call the budget can't cover, and can be resumed with more budget.
4. **Review the findings.** The analysis page shows progress as stored counts, then four sections:
   - potential contradictions;
   - likely compatible testimony;
   - insufficient evidence;
   - needs your review.

   Open a finding to see both passages side by side, with the cited lines highlighted, the model's explanation (labelled as interpretation), how each citation was checked, and why it scored what it did.

The score is **assessment support**: how strongly the evidence supports the proposed classification under rubric v1 (see `DESIGN.md`, "Confidence scoring"). It is not a probability that the witness contradicted themself. For a likely-compatible finding, it is support for "compatible".

## Demo

With the Ellison depositions ingested (`scripts/ingest.ts`) and `npm run dev` running:

```bash
npx tsx scripts/demo.ts
```

This stores the synthetic fixture cases and starts two demo analyses through the API. Neither calls a model.
- **U.S. v. Oracle, Lawrence Ellison.** The six stored Sonnet assessments from the October 29 pilot are replayed; all six found the pairs compatible. The other 294 selected pairs have no stored assessment and are counted as such.
- **Marcus Webb (synthetic, clearly labelled).** Five stored Sonnet assessments (prompt adjudicate-v2) are replayed: two potential contradictions, two likely compatible, and one for review.

The synthetic testimony is invented and is labelled as a fixture throughout. A replayed assessment says it was produced by an earlier Sonnet run. Prepared fixture verdicts say they were not produced by a model.

## Tests

```bash
npm test                          # all tests; Postgres tests run when TEST_DATABASE_URL is set
npm run typecheck                 # server, scripts and tests
npm run build --prefix client     # typechecks and builds the app
```

The end-to-end test (upload both Ellison PDFs, parse them, analyse, read the result) runs when `data/raw/ellison/*.pdf` exist (`scripts/spike/download.sh`). No test calls a model.

## Known limitations

- **New analyses use `adjudicate-v3`, ten independent requests at once.** In a live 40-pair comparison it found all 7 labelled contradictions and wrongly flagged 2 of 9 compatible pairs. That is a small sample, and a 300-pair run has not happened yet. Batching was tested and rejected. One-at-a-time remains as a fallback.
- **No claim tagging for new uploads.** It is paid (Haiku), so Path A uses only claims already tagged; a new upload is retrieved by Path B alone.
- **Demo mode can only replay what exists.** For the real Ellison sessions, that is six assessments.
- **Live analyses run one pair at a time.** About 5 s per pair, so roughly 25 minutes for 300 pairs.
- **No authentication or per-user access control.** This is a local application.
- **Review state isn't editable in the UI yet.** That covers confirming or dismissing a finding.

## How I used AI

I used Claude to help draft and review code. I made the design decisions, tested every rule against the sample transcripts and a larger test transcript, and changed AI suggestions when they failed on real data. For example, a suggested rule to mark any quote with several times as uncertain would have broken the "Around 10, maybe 10:30" case, so I replaced it with the 60-minute rule.

## Evidence strength

Direct findings use the `evidence-strength-v1` checklist, 20 points per check: quotations match (20, or 10 if approximate), the statements are the witness's (20), clear assertions (10 per side), same subject per the model (20), and a conflict that holds without missing context per the model (direct 20, inferential 10). It is not a probability that the witness contradicted themselves, and it sets neither the lane nor the priority: High needs a direct classification, one subject and at least one plain assertion, and other conflicts are Medium.
