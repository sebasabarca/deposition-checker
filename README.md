# Deposition Contradiction Detector

Compares two deposition transcripts from the same witness and highlights where their story contradicts itself. Each flagged contradiction is classified as a **direct contradiction**, an **inferential contradiction** or a **likely false positive**, with a confidence score calculated by this app's own logic rules.

**Main rule: Claude proposes, the app calculates the confidence score.** Claude finds candidate contradictions and provides a brief explanation. The app checks that every quote exists in the transcripts, compares times with deterministic logic, measures how consistent Claude is across multiple runs, and calculates the confidence itself. Claude never returns a confidence score.

## Run it

Requirements: Node.js 20 or newer and an Anthropic API key.

```bash
cp .env.example .env      # then add your ANTHROPIC_API_KEY
npm install && npm run dev
```

Open http://localhost:5173. The sample transcripts load automatically, and you can paste your own.

| Variable            | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Your API key. Only the server reads it; it never reaches the browser. |
| `ANTHROPIC_MODEL`   | The Claude model to use.                                              |

Other commands: `npm test` runs the unit tests, `npm run typecheck` checks types.

## How it works

1. **Parse** each transcript into numbered question and answer pairs (`T1-1`, `T2-3`...), so every claim has a reference a lawyer can check.
2. **Ask Claude 3 times in parallel** for candidate contradictions using structured outputs. Each candidate must include the answer IDs, word-for-word quotes, a proposed type and an explanation. The response format is validated with zod to ensure consistency. If one run fails, the other runs are still used.
3. **Group** the same pair across runs and take the majority type. When two types are tied, the app picks the more cautious label (false positive, then inferential, then direct).
4. **Evidence gate:** both quotes must exist in the transcripts (score of 0.6 or higher). Otherwise the finding is marked **Unverified**, gets no confidence score, and the app reports what went wrong.
5. **Time check:** times are turned into ranges and compared (see below).
6. **Score, band and sort** each finding, with a plain-English list of reasons.

## Confidence rubric

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

## Quote verification

Quotes are normalized (lowercase, punctuation and spacing ignored) and must exist inside the answer they cite. An exact match scores 1.0. If the words are present but not in the exact order, the score is at most 0.9, based on how many words match. Common words like "I", "the" and "was" are ignored, because otherwise an invented quote could pass just by sharing them.

## Time check

Answers one question only: can the times in two quotes refer to the same moment?

- A hedged time ("around 8", "maybe 10:30") becomes a range of ±30 minutes. A precise time ("8:05", "8 PM sharp") gets ±5 minutes. These tolerances are not legal standards, just heuristic values.
- A time without AM or PM is considered both ways, and the times count as compatible if any reading overlaps.
- A bare number only counts as a time if it's after a time word ("at", "around", "until") and not before a plural noun, so "about 5 people" is not a time.
- Several times in one quote are combined only if they are within 60 minutes of each other ("10, maybe 10:30"). Otherwise the result is "uncertain".
- Ranges are compared on a 24-hour clock, so 11:55 PM and 12:05 AM can overlap.

## What was wrong with the original app

- It called the Anthropic API directly from the browser, which would expose the API key. In this app, the call goes through a small Express server, so the key stays on the server.
- The response was parsed using a regex and `JSON.parse` with no validation of the output, and `max_tokens: 1000` could cut the JSON off. It now uses structured outputs, zod validation and clear errors for truncated or refused responses.
- `severity` came straight from the LLM. Confidence is now calculated by the app.
- Nothing checked that the quotes were real, and the three types were never defined in the prompt.
- Transcripts were hardcoded, and there was no legend, no explanation of results and no tests.

## Tests

`npm test` covers the transcript parser, quote verification, the time check and the scoring engine. The scoring tests run without an API key, because `scoreFindings` is a pure function that takes Claude's results as input. Cases include invented quotes, real quotes under the wrong ID, disagreeing runs, duplicate findings, overlapping and non-overlapping times, and quantities that look like times.

## Known limitations

- The time check handles times only, not dates, quantities ("a few" vs "three") or durations.
- It cannot tell which event a time refers to. This depends on Claude pairing the right statements.
- Quote matching is word-based, so a paraphrase with the same key words can still pass the gate with a penalty.
- Three runs per analysis triples the API cost and time. This is a tradeoff I decided to take, because agreement between runs gives a confidence signal I can measure myself.
- Scores are heuristic and would need labelled transcripts to calibrate.

## How I used AI

I used Claude to help draft and review code. I made the design decisions, tested every rule against the sample transcripts and a larger test transcript, and changed AI suggestions when they failed on real data. For example, a suggested rule to mark any quote with several times as uncertain would have broken the "Around 10, maybe 10:30" case, so I replaced it with the 60-minute rule.

## Project structure

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
