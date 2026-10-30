# Deposition Checker

Finds potential contradictions in a witness's sworn testimony across deposition sessions, and shows a lawyer both passages side by side, verbatim, at their page:line.

- **Retrieval.** Two retrieval paths find candidate pairs of exchanges: structured claims and full-text search.
- **Classification.** Claude Sonnet classifies each pair as direct, inferential, a likely false positive, or insufficient evidence.
- **Verification and scoring.** Code checks every citation against the stored transcript, reads who actually said what, and scores the assessment with a fixed, published rubric. Claude never returns a score.
- **Where findings go.** Findings whose citations can't be verified aren't scored: they go to a "Needs your review" section.

## Setup

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
| `ANTHROPIC_MODEL` | v1's Quick compare only. |

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

## v1: Quick compare

The original two-transcript analyzer is still available in the app at **Quick compare (v1)** (`#/classic`). The sections below describe it.

### How it works

1. **Parse** each transcript into numbered question and answer pairs (`T1-1`, `T2-3`...), so every claim has a reference a lawyer can check.
2. **Ask Claude 3 times in parallel** for candidate contradictions using structured outputs. Each candidate must include the answer IDs, word-for-word quotes, a proposed type and an explanation. The response format is validated with zod to ensure consistency. If one run fails, the other runs are still used.
3. **Group** the same pair across runs and take the majority type. When two types are tied, the app picks the more cautious label (false positive, then inferential, then direct).
4. **Evidence gate:** both quotes must exist in the transcripts (score of 0.6 or higher). Otherwise the finding is marked **Unverified**, gets no confidence score, and the app reports what went wrong.
5. **Time check:** times are turned into ranges and compared (see below).
6. **Score, band and sort** each finding, with a plain-English list of reasons.

### Confidence rubric (v1)

The score expresses confidence in the **assigned classification**, whatever the type. It is a heuristic, not a probability, because there is no labelled data to calibrate it.

| Signal                                                                  | Effect       |
| ----------------------------------------------------------------------- | ------------ |
| All runs found the pair with the same type                              | start at 90  |
| At least 60% of runs agree                                              | start at 65  |
| Fewer                                                                   | start at 35  |
| A quote is close but not word for word (it might have been paraphrased) | −15          |
| The time check supports the label                                       | +10          |
| The time check challenges the label                                     | capped at 60 |

Bands: **High** 75 and above, **Medium** 50 to 74, **Low** below 50.

Results are sorted by review priority: high-confidence direct contradictions first, then other contradictions, then rejected false positives (collapsed), then unverified findings that need a manual check.

**The time check never changes the type.** "I was home around 8" and "I was at the bar around 8" have overlapping times but still contradict each other about place, so the rule only confirms or lowers confidence and explains why.

### Quote verification

Quotes are normalized (lowercase, punctuation and spacing ignored) and must exist inside the answer they cite. An exact match scores 1.0. If the words are present but not in the exact order, the score is at most 0.9, based on how many words match. Common words like "I", "the" and "was" are ignored, because otherwise an invented quote could pass just by sharing them.

### Time check

Answers one question only: can the times in two quotes refer to the same moment?

- A hedged time ("around 8", "maybe 10:30") becomes a range of ±30 minutes. A precise time ("8:05", "8 PM sharp") gets ±5 minutes. These tolerances are not legal standards, just heuristic values.
- A time without AM or PM is considered both ways, and the times count as compatible if any reading overlaps.
- A bare number only counts as a time if it's after a time word ("at", "around", "until") and not before a plural noun, so "about 5 people" is not a time.
- Several times in one quote are combined only if they are within 60 minutes of each other ("10, maybe 10:30"). Otherwise the result is "uncertain".
- Ranges are compared on a 24-hour clock, so 11:55 PM and 12:05 AM can overlap.

### What was wrong with the original app

- It called the Anthropic API directly from the browser, which would expose the API key. In this app, the call goes through a small Express server, so the key stays on the server.
- The response was parsed using a regex and `JSON.parse` with no validation of the output, and `max_tokens: 1000` could cut the JSON off. It now uses structured outputs, zod validation and clear errors for truncated or refused responses.
- `severity` came straight from the LLM. Confidence is now calculated by the app.
- Nothing checked that the quotes were real, and the three types were never defined in the prompt.
- Transcripts were hardcoded, and there was no legend, no explanation of results and no tests.

### v1 tests

`npm test` covers the transcript parser, quote verification, the time check and the scoring engine. The scoring tests run without an API key, because `scoreFindings` is a pure function that takes Claude's results as input. Cases include invented quotes, real quotes under the wrong ID, disagreeing runs, duplicate findings, overlapping and non-overlapping times, and quantities that look like times.

### v1 limitations

- The time check handles times only, not dates, quantities ("a few" vs "three") or durations.
- It cannot tell which event a time refers to. This depends on Claude pairing the right statements.
- Quote matching is word-based, so a paraphrase with the same key words can still pass the gate with a penalty.
- Three runs per analysis triples the API cost and time. This is a tradeoff I decided to take, because agreement between runs gives a confidence signal I can measure myself.
- Scores are heuristic and would need labelled transcripts to calibrate.

### How I used AI

I used Claude to help draft and review code. I made the design decisions, tested every rule against the sample transcripts and a larger test transcript, and changed AI suggestions when they failed on real data. For example, a suggested rule to mark any quote with several times as uncertain would have broken the "Around 10, maybe 10:30" case, so I replaced it with the 60-minute rule.

### v1 project structure

```
server/src/
  index.ts        Express API: /api/samples and /api/analyze
  transcript.ts   Splits transcripts into numbered Q&A pairs
  schema.ts       zod schema for Claude's output
  claude.ts       Claude call with structured outputs
  verify.ts       Quote verification (evidence gate)
  ambiguity.ts    Time check
  analyze.ts      Runs, grouping, scoring and sorting
client/src/       React interface
tests/            Vitest unit tests
scripts/try.ts    Runs an analysis from the command line
```
