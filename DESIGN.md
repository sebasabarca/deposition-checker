# Deposition Checker v2: Design and Build Plan

Oct 27, 2026 · @Sebastian

## Summary

v2 turns each deposition into page:line source lines and Q/A exchanges. Two independent retrieval paths (statement cards grouped into topics, and full-text search of the original testimony) find candidate pairs, and Sonnet sees only compact evidence packets, which it must answer with exchange IDs. Code then checks the sources deterministically, keeps the model's interpretation labelled as interpretation, and scores each finding with a fixed, explainable rubric. Every model call is logged with its tokens and cost, so the demo reports measured cost instead of an estimate.

Every trade-off follows one order: correct evidence, reliable retrieval, defensible adjudication, excellent UI, measured cost, demonstrable scalability.

Due end of day Tuesday, November 3, 2026, Pacific, as a reply to Edward's thread with the repo and a short video.

**What changed in the October 28 revision**

1. **Scoring redesigned.** No voting. Evidence status, a 0 to 100 assessment support score, and review priority are computed separately by a versioned TypeScript rubric. Claude classifies but never supplies a number.
2. **Retrieval no longer depends on claim extraction.** An original-testimony path runs on every exchange, whether or not claims were tagged.
3. **Cost is measured.** Every call is priced from logged usage. The 600-input and 300-output tokens per pair behind the planning figures are assumptions, replaced by measured packet sizes after Friday's first real run.
4. **Verification has three layers.** Source verification is deterministic. Claim attribution and semantic adjudication are model interpretation, labelled as such.
5. **Evaluation uses a small, mixed, labelled set.** It reports the number of examples with every metric.
6. **Optional features moved to a prioritized stretch backlog** that cannot delay the core.
7. **Final corrections (October 28, evening).** Attribution caps and yes-or-no polarity in scoring, every test value recomputed, Path B's query mode and the per-exchange cap chosen by measurement, cost assumptions labelled, and real-deposition processing reported separately from PDF parsing.

**What changed in the October 30 revision (approved October 30)**

1. **Retrieval is rebuilt around comparable testimony.** The first full Ellison run (analysis #11: 300 pairs, 110 s, $1.8867, no failed requests, 297 of 300 citations verified) found no contradictions. 266 of the 300 adjudicated pairs were about different events, and 2,687 of 2,987 candidates were never assessed, 1,639 of them because of the per-exchange cap. Lexical overlap finds the same topic, not the same event. That run measured performance; it did not establish recall on real testimony. Path A is redesigned as **statement cards** grouped into a **multi-membership topic map**.
2. **Path B stays an independent discovery path.** It keeps searching the original testimony, and doesn't depend on cards or topics. Both paths feed one deduplicated candidate pool, with provenance recorded. A separate Path B audit samples cross-topic matches to estimate what the map missed.
3. **The per-exchange cap and the 300-pair budget are replaced by a shared dollar ceiling with explicit coverage accounting.** No candidate is silently discarded.
4. **Production adjudication is unchanged:** `adjudicate-v3`, one pair per request, concurrency 10. Topic-packet adjudication is an experiment and must earn promotion. The pair pipeline stays as the fallback until the new system passes end-to-end evaluation.
5. **Scoring, verification and the verdict schema are unchanged.** Each finding is still a pair of exchanges with one verdict, scored by `RUBRIC_V1`.
6. **This architecture is experimental.** It runs alongside the existing retrieval, and it isn't described as better until evaluation shows that.

The four open decisions were approved on October 28 and are recorded in the last section. Planning is complete.

## Where v1 stands

The verification and scoring core of v1 is sound and carries over almost unchanged; what breaks is the input format and the "whole transcript in one prompt, three times" pattern. I read the repo at commit `da1c692` (about 900 lines across server and client).

| v1 piece | File | v2 fate |
| --- | --- | --- |
| Quote matching (`normalize`, `quoteMatchScore`, stopwords) | `server/src/verify.ts` | Keep. It becomes the key-phrase check inside Layer 1 source verification. Exact ID validation around it is new. |
| Wrong-reference detection (`findQuoteElsewhere`) | `server/src/analyze.ts` | Keep. It produces the `wrong_reference` evidence status. |
| Time check (hedges, AM/PM, 24-hour circle) | `server/src/ambiguity.ts` | Keep as-is. Called only when the adjudicator says the conflict is about the timing of the same event. |
| Bands and priority (`toBand`, `toPriority`, the reasons list) | `server/src/analyze.ts` | Keep the 75 / 50 band thresholds and the reasons pattern. The score now comes from the rubric in Confidence scoring, and priority becomes high, medium, low or needs context. |
| Vote grouping (`majorityType`, `startingScore`, three-run grouping) | `server/src/analyze.ts` | Remove. v2 runs one adjudication per pair, so a vote ratio means nothing. |
| Structured outputs with zod, stop-reason checks | `server/src/claude.ts`, `schema.ts` | Keep the pattern. New schemas for claims and verdicts. |
| `Q:` / `A:` parser, 50,000-character cap | `server/src/transcript.ts`, `index.ts` | Replace with the deposition-aware parser. |
| One synchronous `POST /api/analyze` | `server/src/index.ts` | Replace with uploads plus background jobs. |
| Marcus Webb and Elena Ruiz samples with answer keys | `server/src/data/samples.ts` | Keep as labelled synthetic fixtures, reported separately from real testimony. |
| Single-page React UI | `client/src` | Rebuild as the Contradiction Workbench. |

The v1 bug stories (the `tq_id` typo caught by the evidence gate, the stopword fix, the "5 people" time rule) are worth keeping in the video: they show the "Claude proposes, the app verifies" idea still holds at scale.

## Architecture overview

&#91;embedded content: v2 pipeline · 7 worker steps, 3 request-path parts\]

Path B reads only the parsed exchanges, so candidates still reach adjudication when statement cards or the topic map miss something or fail outright. The worker writes everything to Postgres, and the API and Workbench only read those rows. Verification is the one step where code, not the model, decides whether a finding's evidence is real.

## Ask 2: Real depositions without overflow, drift or hallucination

No model call sees more than about 10 pages, state lives in Postgres instead of a growing prompt, and every quote the lawyer sees is rendered from the stored source lines, never from model output. The next four sections cover the four parts: ingestion, retrieval, verification and scoring.

**Ingestion**

1. **Parser spike first (Wednesday morning). Done October 27: `pdfjs-dist` chosen provisionally; results, method and limitations in `docs/parser-spike.md`.** Run on Ellison P3171 and P3173, since the public Gates PDFs have no text layer. Original plan: take one deposition PDF, parse representative pages, rebuild at least 20 exchanges including a multi-page exchange and short answers, and compare text and page:line against the DOJ HTML version. List every formatting failure. Then choose: TypeScript (`pdfjs-dist`, or `pdftotext -layout` through a child process) or a small PyMuPDF command-line utility that writes JSON lines, run by the worker. The utility is a script, not a service. Decision rule: pick the option that reproduces at least 99% of sampled lines exactly with the correct page:line; if both do, pick TypeScript. If neither does, the approved fallback applies: the demo ingests the DOJ HTML transcript of the same sessions through a small HTML reader in `ingest/`, and the PDF parser stays in the repo with its measured accuracy and failures documented. Processing real depositions and parsing PDFs are reported as separate results, and HTML success is never presented as proof that PDF parsing works. Pages with no text layer are read by local OCR (see "Implementation note: OCR").
2. **Source lines.** Each line stores printed page, PDF page index, line number, speaker, raw text and normalized text. Headers, footers and the line-number gutter are stripped. Pages with no readable text after OCR are recorded as `needs_ocr` and counted in the ledger, never dropped silently. Pages whose only text is a header or footer are counted separately as blank pages. **Every extracted line is stored, whether or not it belongs to an exchange**: questions, answers, objections, colloquy, parentheticals and fragments after a redaction gap all stay traceable to their page:line. Speaker is `attorney`, `witness`, `colloquy` (with the speaker's name), `parenthetical` or `unknown`. Text with an `unknown` speaker is kept, but is never treated as a witness assertion. An explicit speaker label that ingestion doesn't recognize (anything like `COURT REPORTER:`) makes the speaker `unknown`; it never inherits the previous speaker. Attorney labels may have multi-word surnames (`MR. VAN DYKE:`).
   - **Page status (approved October 27).** Every PDF page gets one explicit status: `text` (passed validation), `blank` (only a header or footer), `needs_ocr` (no text layer, and OCR found none or could not run) or `failed` (has text but fails a layout check, with the reasons recorded). Checks run against the validated layout profile and include: line number matches the line's position, printed page present and in order, no unnumbered rows, no duplicate or out-of-range line numbers, and footer text in the expected form.
   - **Deposition status.** `ready` when every page is `text` or `blank` and at least one is `text`; `needs_review` when some pages are `text` and others are `needs_ocr` or `failed`; `unsupported` when no page is `text` (for example an image-only PDF, or a layout the profile does not match) or the file cannot be read. **Only `ready` depositions are used for contradiction analysis.** The parser does not try to handle other layouts, with one exception approved November 2: a PDF with a text layer whose pages have no line-number gutter at all (no page fits the layout, OCR finds none, and its rows don't start with line numbers) is read by physical line, numbering each page's rows within that PDF page, with layout `pdf-physical-v1` (`ingest/physical.ts`). Those references are labelled "physical line, not an official line number" everywhere they appear and never reach the contradictions lane.
   - **Processing and failed (approved October 28).** An uploaded deposition is `processing` until the worker has read it; its `page_count` and `validation` stay null until then, never placeholders. `failed` means the worker itself failed on all 3 attempts (a crash, a missing or damaged stored file, a database error), as opposed to a PDF that was read and found unusable (`unsupported`). The error is kept in `ingest_error`, and a failed deposition is re-queued only by an explicit retry. A failure is recorded only while the deposition is still `processing`, so it never overwrites a finished deposition or its evidence.
   - **Ingestion runs.** `ingest_run` is 1 at upload and goes up by one with each explicit retry. Every job carries the run it was queued for, and a job or a failure acts only while that run is current, so a late or redelivered message from an earlier run can't fail or redo a newer one. The worker checks the run again inside the save transaction, with the deposition row locked, so an attempt that was given up on while still parsing can't save over a newer run.
   - **Parser version at processing time.** A `processing` deposition has no lines yet, so its `parser_version` only records the parser that was expected. If the worker runs a different version (the parser changed between upload and processing), the deposition takes the worker's version and is ingested in place. If the file is already stored under the worker's version, the queued deposition is marked `failed` with a pointer to the existing one. A job never completes while its deposition is still `processing`.
3. **Exchanges.** A question, its answer, and any objections or colloquy become one exchange, even across page breaks, stored as first and last line IDs. Kinds are `qa`, `colloquy`, `objection` and `exhibit`. An answer longer than 40 lines is split into overlapping parts that share a `group_id`. Exchanges and parts reference source lines by ID and never copy them, so overlapping parts point at the same lines without duplicating the evidence. Each exchange records flags for incomplete context: `starts_mid_turn`, `ends_at_gap`, `no_answer`, `no_question`.
   - **Line references (approved October 27).** Each part stores its question range (`question_first_line_id`, `question_last_line_id`), its answer range (`answer_first_line_id`, `answer_last_line_id`) and its overall span (`first_line_id`, `last_line_id`). Because interruptions and redactions make ranges noncontiguous, the exact membership is stored too: `exchange_lines` lists every line of the part with its role (`question`, `answer`, `context` for objections, colloquy and parentheticals, or `unknown`). Nothing assumes that every line between two endpoints is witness testimony.
   - **Splitting long answers.** Only witness answer lines count toward the 40-line limit. Parts hold 40 answer lines and consecutive parts share 5 (answer lines 1–40, 36–75, and so on). Every part includes the full original question. Objections, interruptions and other context lines stay in their original order inside the part whose answer lines surround them, and never count toward the limit. Every witness answer line belongs to at least one part.
   - **Derived text.** Three fields are derived from the lines. `question_text` and `answer_text` are for retrieval: attorney and witness turns, one turn per line, so separate answers are never merged across an interruption. `dialogue_text` is the model input: every turn of the part in source order, labelled by speaker (`Q:`, `A:`, `MR. SCOTT:`, `UNKNOWN SPEAKER:`, `NOTE:`), so an attorney's correction or clarification stays between the answers it separates, and a later part of a split answer shows `[…]` where it resumes after the question. The stored source lines are authoritative: every quotation shown in the UI is rebuilt from them, never from derived text or model output.
4. **Idempotent by design.** A deposition is keyed by `file_sha256` plus `parser_version`. A re-run rewrites that deposition's lines and exchanges inside one transaction, so a retry can never duplicate source records.
5. **Input and storage (approved October 27).** Production ingests PDFs only. The DOJ HTML reader stays a validation tool and fallback candidate, not part of production ingestion. For the demo, uploaded PDFs are stored locally under `data/uploads/`, with an S3-ready `storage_key`. A command-line ingester is acceptable during development, but the finished application runs ingestion as a background job, so no user request waits on parsing. **Built October 28:** the upload endpoint stores the file, records the deposition as `processing` and queues a pg-boss job in the same transaction, then answers at once; a separate worker process reads and saves it. Ingestion progress is tracked by the deposition's status (`processing`, then `ready`, `needs_review`, `unsupported` or `failed`), not by `job_stages`, which arrives with the analysis jobs. pg-boss makes 3 attempts with exponential backoff and a 30-second heartbeat, so a crashed worker's job is retried within about 30 seconds. After the last attempt, the job moves to a dead-letter queue whose worker records the failure, retrying for about 3 hours if the database is down. Uploading a file already in the case returns the existing deposition without queuing it again. Requires Node 22.12 or later (pg-boss 12).

## Candidate retrieval: two independent paths and one candidate pool

The pipeline is: original testimony, statement cards, a multi-membership topic map, candidate discovery, contradiction adjudication, then the existing verification and scoring. Path B runs beside it on the original testimony. A pair is always two exchanges from the same witness in different sessions.

A contradiction needs the same event and the same slot (time, place, amount, action) with different values. Shared words only show the same topic, so Path A first works out what each answer asserts and groups comparable assertions. This follows the legal tools that describe their method (DiscoverLex, Eve, CaseMap's fact records) and the research on testimony and event matching (MIND/INTEND's who-what-when-where slots; LLM event summaries for cross-document coreference; Claimify's decontextualized claims; contextual retrieval). The pair-first retrieval stays in place until this design passes evaluation.

### Path A: statement-centered topic retrieval

**Step 1: statement cards (Haiku, `claims/`, once per deposition).** The model reads one chunk of about 10 pages, overlapping the next chunk by one page, as `dialogue_text` with exchange IDs. An exchange may yield **zero, one or several cards**: "We met in March, discussed pricing in April, and signed the agreement in May" is three cards.

```ts
type Stance = 'asserts' | 'denies' | 'not_answered' | 'unclear'
type Epistemic = 'asserted' | 'qualified' | 'does_not_recall' | 'does_not_know' | 'hypothetical' | 'reported_by_other'
type StatementCard = {
  cardId: string                     // assigned by code
  exchangeId: string                 // must be a qa part in this chunk; checked by code
  sourcePhrase: string               // verbatim words the card rests on, used only to ground it and resolve its lines
  statement: string                  // the assertion rewritten to stand alone: pronouns and "that meeting" resolved
  event: string                      // one line: what event or topic it is about, with its date if known
  subject: string; entities: string[]
  predicate: string; object: string | null
  time: string | null; location: string | null; amount: string | null
  stance: Stance
  epistemic: Epistemic
  extractorVersion: string           // set by code
}   // strict schema; no confidence or score fields. Page:line range: resolved by code from sourcePhrase, where it can be.
```

A card is a **retrieval representation only**. It is never evidence, its text is never shown as testimony, and it earns no points in scoring. The original transcript is always authoritative.

Code checks every card, and keeps every rejected one with its reason:

| Case | Rule |
| --- | --- |
| Several cards on one exchange | Allowed. Each is checked on its own |
| Invalid exchange ID | Rejected: the ID must be a `qa` part in that chunk |
| Unsupported source span | `sourcePhrase` isn't found in the exchange's lines: rejected as ungrounded, and kept out of the topic map |
| Statement that can't be grounded | Its `sourcePhrase` is grounded but its named entities aren't supported by the exchange: those entities are stored as ungrounded and not used for retrieval |
| Duplicates from overlapping chunks | An exchange already carded by an earlier chunk keeps its cards: a later chunk's cards for it are `duplicate_card`, whatever their wording (approved October 30, after the pilot) |
| Exchange with no witness answer | Any card is rejected as `no_witness_answer`, and the exchange is `no_assertion` |
| Double negative | A `denies` card with a negated statement is rejected as `negated_denial`; other negated statements are counted |
| Exchange with no substantive assertion | Recorded as `no_assertion`, which is different from unprocessed |
| Extraction omission | An exchange in a chunk the model never mentioned is `omitted` and counted |

**Telling silence from no claims.** The response has a `noAssertion` list, which is how the model says an exchange has nothing to card; an exchange in neither `cards` nor `noAssertion` is `omitted`.

**Coverage is explicit.** Every `qa` part has one status per extractor version: `carded`, `no_assertion`, `omitted`, `failed`, or `not_processed`. An unprocessed exchange is never treated as having no claims. Procedural exchanges are counted separately. Cards are cached by deposition, parser version and extractor version, so a re-run costs nothing.

**Step 2: multi-membership topic map (Haiku, `claims/`, once per witness and change).** One call reads the short `event` lines of every card from all of the witness's ready sessions, with their card IDs, and returns named topics, each listing its card IDs.

- **Primary topic:** every assigned card has exactly one, used to organize the UI.
- **Secondary topics:** optional, used for retrieval. A statement on a PeopleSoft pricing negotiation may belong to PeopleSoft negotiations, pricing and discounts, and acquisition strategy. There is no membership cap until evaluation shows its effect on recall.
- **Validation:** unknown card IDs are rejected and duplicates within a topic are dropped; a card given no primary topic goes to "unassigned", and is counted.
- **Versioning:** each map has a `map_version`, and candidates record the version that produced them.
- **New sessions:** a new deposition's cards are assigned to the existing topics (a new topic is allowed), so unchanged sessions aren't read again.
- **Large witnesses:** above about 2,000 cards, the map is built per session first and the per-session topics are merged.

A topic's name is a label for the lawyer, never evidence.

**Step 3: candidate discovery (code, `retrieve/pathA.ts`).** Within a topic, cards from different sessions form candidate pairs of their logical exchanges. Pairs are ranked within Path A: opposite stance, then a different value in a shared slot (time, location, amount, object), then shared entities. Those are reasons to adjudicate, never established contradictions. A pair found through several topics is **one candidate** that records all of them, so sharing two topics never means two comparisons.

### Path B: original-testimony retrieval

Path B runs as built (`retrieve/pathB.ts`: both query modes, scoring, ranking) on `exchanges` only. It finds cross-session pairs whether or not their statements share a topic, and it doesn't depend on extraction or topic assignment succeeding. If cards fail completely, Path B still produces candidates.

### Candidate pool and selection

1. **Union.** Both paths' pairs are deduplicated on stable source identifiers (deposition and logical exchange group). Each candidate records its provenance: Path A only, Path B only, or both. Path A never suppresses a candidate unique to Path B.
2. **Rank within each path.** There is no fusion across paths.
3. **Allocate.** The first experiment gives about **60% of adjudication capacity to Path A and 40% to Path B**. These are experimental targets, not permanent rules. Capacity left unused by a path with too few eligible candidates may be redistributed. Path A can't consume the budget before Path B has contributed.
4. **Bill once, count twice.** A candidate found by both paths counts toward both paths' retrieval coverage, but is assessed and billed once.
5. **Account for everything.** Every candidate is accounted for by `candidates.status`, and nothing is silently dropped:

| `status` | Meaning | Reached from |
| --- | --- | --- |
| `selected` | Awaiting assessment | Selection, or `deferred` when capacity is added. A request that failed, or an invalid verdict, leaves it here until an explicit retry |
| `adjudicated` | Assessed: it has a valid verdict | `selected` only |
| `deferred` | Not selected this run, with `deferred_reason` | Selection, or `selected` when the budget stops first |
| `excluded` | Never to be assessed, with `exclusion_reason` | Selection |
| `audit` | Chosen for the Path B audit sample | Selection |

`retrieval_version` identifies one reproducible retrieval **and** ranking configuration: changing the query mode, a ranking rule, the extractor version, or the allocation is a new version. `map_version` records the topic map on its own.

Each request still reserves its worst-case cost atomically before it is sent, and the existing safeguards against unintended paid calls stay.

### Path B audit

Separately, a random sample of 20 from the top 200 Path B pairs whose exchanges share no topic estimates what the topic map missed. A sampled pair already assessed reuses its verdict, so it isn't billed twice. A hit is reported as a map miss. **A small sample can reveal misses, but it can't establish complete recall.** Findings from Path A, Path B and the audit all feed one evaluation, by candidate.

**Embeddings remain a measured add-on.** If the audit shows the map splitting one event across topics, embedding the `event` lines and merging near-duplicate topics is the first fix tried.

## Evidence verification: three layers

Only the first layer is deterministic. The other two are model interpretation with deterministic cross-checks, and the UI labels them that way.

**Layer 1: source verification (code).** For each side of a verdict: the exchange ID exists, it is one of the two exchanges in the packet (in a topic-packet experiment: both IDs are in the packet, and they come from different sessions of the same witness), its deposition belongs to the finding's witness, its line range resolves, and the model's key phrase is found in that exchange (`quoteMatchScore`). The displayed text always comes from `lines`. The result is one evidence status:

- `verified`: IDs valid and the key phrase matches exactly.
- `approximate`: IDs valid, key phrase matches at 0.6 to 0.99.
- `wrong_reference`: the phrase is found in a different exchange than the one cited.
- `unsupported`: an invalid ID, or a phrase found nowhere.

A finding citing an exchange outside its packet is `unsupported`. Only `verified` and `approximate` findings are scored. The other two go to an "Unverified, check manually" section with no confidence band. Layer 1 also records where the phrase sits: in the witness's answer, in a question followed by a plain affirmative answer, in a question followed by a plain denial, in a question with any other answer, or in an attorney's statement, objection or colloquy with no witness answer.

**Layer 2: claim attribution (code and model, cross-checked).** The adjudicator labels each side as `asserted`, `qualified`, `does_not_recall`, `reported_by_other`, `hypothetical`, `attorney_statement` or `unclear`, and says whether the witness `affirms` or `denies` the proposition in the key phrase. Code makes its own reading of each side, and the side's attribution level is the lower of the two readings, in this order: `clear`, `qualified`, `uncertain`, then `not_adopted` or `no_recall`. The code's rules:

- **No recall.** An answer that matches a no-recall pattern ("I don't recall", "I don't remember", "not that I recall", "I don't know") is `no_recall`, whatever the model said.
- **Yes-or-no answers.** When the key phrase is in the attorney's question, code reads the answer (`readAnswer`). A plain affirmative ("Yes.", "Yes, sir.", "Correct.", "That's right.", "I did.") means the witness affirms the question's proposition, a clear assertion. A plain negative ("No.", "No, sir.", "Incorrect.", "I did not.", "Never.") means the witness denies it, so the witness's assertion is the negation; code never reads a denial as affirming the question. Anything else leaves the side `uncertain` rather than assuming the witness adopted the question: "Yes, but…", "I believe so", "Not exactly", "Uh-huh", a nonresponsive answer, or a bare yes or no to a negatively phrased or tag question ("You didn't sign it, did you?").
- **Not adopted.** A phrase found only in an attorney's statement, a question the witness never answered, an objection or colloquy is `not_adopted`, and so is a side Claude labels `hypothetical`, `reported_by_other` or `attorney_statement`. If Claude's affirm-or-deny reading contradicts the code's reading of a plain yes or no, the side is also `not_adopted`, because the witness did not assert the proposition Claude relied on.
- **Qualifiers.** An epistemic qualifier governing the phrase ("I think", "I believe", "probably", "to the best of my recollection"), or Claude's `qualified` label, makes the side `qualified`. Conditional wording ("if I had", "would have", "assuming") makes it `uncertain`. Approximation words such as "about" or "around" are not qualifiers; they feed the time check and the uncertainty deduction.
- **Path A disagreement.** If Path A tagged the same exchange with a different epistemic status, the disagreement becomes an ambiguity reason.

With your example question, "Did you approve the transaction?": "Yes." is a clear assertion that the witness approved it, and "No." is a clear assertion that the witness did not. "I don't remember." passes Layer 1, but Layer 2 makes the side `no_recall`, so a direct or inferential score is capped at 40 (Low) whatever Claude classified it as. If Claude classifies the same pair as a false positive because of uncertain recollection, the same check counts as support instead.

**Layer 3: semantic adjudication (model).** Sonnet judges event identity, time and date, subject, scope, context, alternative explanations and changed circumstances. Its output is stored as Claude's assessment and is never called verified.

The verdict schema is defined under Confidence scoring, because its fields are the scoring engine's model-derived inputs.

## Confidence scoring

Claude reasons about contradictions, TypeScript calculates confidence, and source evidence is verified independently. This follows Edward's rule: "confidence scores have to come from your own logic, not passed through from the LLM." Claude returns a classification and categorical observations, never a number, band, probability or certainty rating. A pure TypeScript function turns those observations, plus checks the code performs itself, into a 0 to 100 assessment support score using a versioned, published rubric. Deterministic calculation does not mean every input is independent of the model, so the rubric and the UI label each input by its origin: Code, Claude, or both.

**Three separate outputs**

1. **Evidence status** (Layer 1, code): `verified`, `approximate`, `wrong_reference`, `unsupported`. Only the first two are eligible for a score.
2. **Assessment support score** (0 to 100) and band: how strongly the available evidence supports the classification Claude proposed, under this rubric. It is not a probability that the witness lied or that the classification is correct, and it will not be described as calibrated.
3. **Review priority:** `high`, `medium`, `low` or `needs_context`, computed separately.

**Critique of the proposed 25 / 15 / 25 / 15 / 20 split**

- *Source verification should be a gate, not points.* Giving it 25 points means a finding with a fabricated citation could still score 75. Every eligible finding would also collect nearly all 25, which squeezes the useful range. The gate decides eligibility, and only the exact-versus-approximate difference stays in the score (4 points).
- *Evidence completeness overlaps with attribution and is nearly constant,* because packets always carry whole exchanges. It shrinks to a 10-point context component.
- *Classification-specific checks were doing two jobs.* They mixed Claude's semantic observations with code-checkable facts. Splitting them keeps the origins honest: semantic support (Claude, 30) and corroboration (code, 15).
- *Corroboration must be a bonus, never a requirement.* If missing corroboration could drop a finding a band, your authorization example would fail for lack of shared words. At 15 points, a finding with no corroboration but otherwise clean can still reach 85, which is High.
- *Ambiguity is clearer as deductions* from a full allowance (25), so every lost point names a specific reason.
- *Weights follow severity tiers, not taste.* With High at 75, a major problem costs 15 or more, which is enough to move a perfect finding toward Medium when combined with one other issue. A moderate problem costs about 10, a minor one 4 to 5. Hard caps handle problems that should decide the band on their own. The weights are rubric version 1, fixed before the evaluation; if High is not more precise than Medium on the labelled set, the rubric gets revised as version 2 and the change is reported.

**The formula**

```latex
\text{score} = \min\big(\text{cap},\; A + C + S + K + U\big), \quad 0 \le \text{score} \le 100
```

| Component | Max | What earns the points | Origin |
| --- | --- | --- | --- |
| A: Attribution and source quality | 20 | Per side: 2 for an exact key-phrase match, plus points for the side's attribution level (see Layer 2): clear 8, qualified 4, anything else 0. For a false positive, a side earns the 8 when the code does not contradict Claude's attribution label, whatever that label is, because no recollection or an unadopted question can be the reason it is a false positive. | Code and Claude; the lower reading wins |
| C: Context sufficiency | 10 | 5 when both exchanges are whole (not split parts, context lines present). 5 when `needsMoreContext` is false. | Code 5, Claude 5 |
| S: Semantic support | 30 | Class-specific; see the next table. Only categorical fields count, never the explanation text. | Claude |
| K: Independent corroboration | 15 | Class-specific code checks, 5 each, capped at 15. Absence scores 0 but is never a penalty. | Code |
| U: Uncertainty allowance | 25 | Starts at 25. Minus 10 if Claude gave an `alternativeExplanation` (for a false positive: an alternative that it might be a real conflict). Minus 5 per side where code finds an approximation word ("about", "around", "approximately") on a direct or inferential finding. Minus 5 if Path A's epistemic tag disagrees with Claude's attribution. Floor 0. | Code and Claude, labelled per deduction |

Claude's observations alone account for at most 35 points (S plus the `needsMoreContext` check) and can deduct 10 (an alternative explanation). Attribution points and caps use the lower of the code's and Claude's reading of each side, so Claude can lower them but never raise them above what the code found. Exactness, completeness, corroboration, the approximation and disagreement deductions, the gate and every cap are code-enforced. Retrieval agreement and Haiku claims earn no points; they are ranking and retrieval signals only, apart from a disagreement deduction that can only lower the score.

**Semantic support (S) and corroboration (K) by classification**

| Classification | S: Claude's categorical observations (max 30) | K: code checks, 5 each (max 15) |
| --- | --- | --- |
| Direct | `sameEvent` yes 12, uncertain 4. `conflictBasis` is `explicit_negation`, `value_conflict` or `mutually_exclusive`: 12 (`requires_inference` scores 0 and adds the reason "conflict needs inference; may be inferential"). `scopeAligned` yes 6, uncertain 2. | Negation asymmetry on a shared content term (one side negated, the other not; a plain "No." to a question counts as negating it, and a side with no witness stance never counts). Conflicting numbers, dates or times found by regex for the same unit (times only when `ambiguity.ts` finds them incompatible). A specific anchor (proper noun, date, number, exhibit) in both exchanges. |
| Inferential | `sameEvent` yes 10, uncertain 3. Inference steps, each citing IDs in the packet that code validates: 10 for at least one fully supported chain, 0 if any step cites an ID that fails. `unestablishedAssumptions`: none 10, one 5, two or more 0. | Shared specific anchor. `ambiguity.ts` finds the times incompatible, when timing matters. Date or sequence order conflict found by code. |
| False positive | `falsePositiveReason` given: 15. That reason consistent with `sameEvent` (`different_event` needs `no`; the others need `yes` or `uncertain`): 15. | `ambiguity.ts` finds the times compatible, when timing matters. A qualifier or approximation word found on a side. A no-recall pattern found on a side. The key phrase found only in an attorney's words or an unanswered question. Different anchors (dates or places) that point to different events. Capped at 15. |

**Gates and caps (applied after the sum, code-enforced)**

| Rule | Effect | Why |
| --- | --- | --- |
| Evidence `wrong_reference` or `unsupported` | No score; Unverified section | Invalid citations can never look verified. |
| `insufficient_evidence` | No score; priority `needs_context` | Claude says it cannot judge. |
| Direct or inferential where neither side's attribution level is clear or qualified | No score; priority `needs_context` | Neither statement establishes an attributable witness assertion. |
| Direct or inferential where a side is `not_adopted` or `no_recall` | Cap 40 | A hypothetical, another person's words, an attorney's statement the witness never adopted, a misread yes-or-no answer, or a failure to recall is not an assertion. |
| Direct or inferential where a side is `qualified` or `uncertain` | Cap 70 | Includes a qualified, ambiguous or nonresponsive answer to a yes-or-no question. |
| Direct or inferential with `sameEvent` = no | Cap 25 | Claude's classification contradicts its own observation. |
| Conflict about timing and `ambiguity.ts` finds the times compatible | Cap 60 (v1's time cap) | Approximate times that overlap cannot support a high-confidence timing contradiction. |
| False positive about timing and `ambiguity.ts` finds the times incompatible | Cap 60 | The times differ beyond tolerance, so this may be real. |
| False positive whose reason is `uncertain_recollection`, `qualified_statement` or `not_adopted_by_witness`, but both sides' levels are clear | Cap 60 | The attribution checks do not support the stated reason, so this may be real. |

Every cap is applied after the component sum, the lowest applicable cap wins, and every applicable cap is listed in the "Why this score?" panel, marked when it lowered the score. The attribution caps (100, 70, 40, unscored) are initial rubric-v1 rules, not statistically calibrated thresholds. They do not apply to false positives, where no recollection, a qualifier or an unadopted question is support for the classification rather than a weakness. The time check runs only when `aboutTimingOfSameEvent` is true. As in v1, it never changes the classification.

**Bands (kept from v1):** High 75 to 100, Medium 50 to 74, Low below 50.

**Review priority**

| Priority | Rule |
| --- | --- |
| `high` | Direct High; inferential High |
| `medium` | Direct Medium or Low; inferential Medium; false positive Low (a weakly supported "harmless" call may hide a real conflict) |
| `low` | Inferential Low; false positive High or Medium; Unverified evidence (shown in its own "check manually" section) |
| `needs_context` | `insufficient_evidence`; no attributable witness assertion on either side (unscored); `needsMoreContext` true; the `sameEvent` = no inconsistency cap; or a reviewer marked it "needs more context" |

The navigator sorts unreviewed findings first, then by priority, score, and retrieval rank. Confirmed and dismissed findings keep their priority but sort below unreviewed ones.

**Verdict schema (Claude's structured output, zod-validated)**

```ts
type Attribution = 'asserted' | 'qualified' | 'does_not_recall' | 'reported_by_other'
  | 'hypothetical' | 'attorney_statement' | 'unclear'
type Stance = 'affirms' | 'denies' | 'unclear'

type Verdict = {
  classification: 'direct' | 'inferential' | 'false_positive' | 'insufficient_evidence'
  evidenceAId: string;  evidenceBId: string          // must be the packet's exchanges
  keyPhraseA: string;   keyPhraseB: string           // Layer 1 check; never displayed
  attributionA: Attribution;  attributionB: Attribution   // who asserts the key phrase, and how
  stanceA: Stance;  stanceB: Stance                  // does the witness affirm or deny the key phrase's proposition?
                                                     // the witness's own words: 'affirms' (any negation is in the phrase);
                                                     // a plain "No." to a question containing the phrase: 'denies'
  sameEvent: 'yes' | 'no' | 'uncertain'
  scopeAligned: 'yes' | 'no' | 'uncertain'           // same time frame and circumstances (direct)
  conflictBasis: 'explicit_negation' | 'value_conflict' | 'mutually_exclusive' | 'requires_inference' | 'none'
  aboutTimingOfSameEvent: boolean                     // gates the time check
  inferenceSteps: { statement: string; supportingIds: string[] }[]   // inferential; IDs checked by code
  unestablishedAssumptions: string[]                  // inferential; counted, not read
  falsePositiveReason: 'compatible_approximation' | 'different_event' | 'qualified_statement'
    | 'uncertain_recollection' | 'not_adopted_by_witness' | 'both_can_be_true' | null
  explanation: string;  alternativeExplanation: string | null
  needsMoreContext: boolean
}   // strict schema: any extra key, such as "confidence", "score", "band" or "probability", fails validation
```

The fields beyond your starting point are justified this way. Key phrases, attributions and stances feed Layers 1 and 2; the stance lets code check Claude's reading of a yes-or-no answer against its own. `scopeAligned` and `conflictBasis` drive the direct checks. `inferenceSteps` and `unestablishedAssumptions` let the code check that an inference is grounded and count what it assumes. `falsePositiveReason` lets a false positive earn high support, including `not_adopted_by_witness` for an attorney's words the witness never accepted, and `aboutTimingOfSameEvent` keeps the time check from firing on place or action conflicts.

**Scoring interface (pure, in `score/`)**

```ts
type Origin = 'code' | 'claude' | 'code+claude'
type Factor = { component: 'A' | 'C' | 'S' | 'K' | 'U'; label: string; points: number; max: number; origin: Origin }
type Cap = { rule: string; limit: number; reason: string; binding: boolean }

type Level = 'clear' | 'qualified' | 'uncertain' | 'not_adopted' | 'no_recall'
type SideAttribution = {
  location: 'answer' | 'question_affirmed' | 'question_denied' | 'question_other' | 'attorney_or_colloquy'
  codeStance: 'affirms' | 'denies' | 'uncertain'          // from readAnswer(); a plain "No." is always 'denies'
  noRecall: boolean; qualifier: boolean; conditional: boolean   // code patterns
  codeLevel: Level; claudeLevel: Level
  level: Level                                            // the lower of the two; a stance mismatch makes it 'not_adopted'
}
type AttributionCheck = { a: SideAttribution; b: SideAttribution }

type ScoringInput = {
  verdict: Verdict; source: SourceCheck; attribution: AttributionCheck
  context: ContextCheck; corroboration: CorroborationCheck
  timeCheck: TimeCheck | null; extractionDisagreement: boolean
}
type Assessment = {
  eligible: boolean; score: number | null; band: 'high' | 'medium' | 'low' | null
  unscoredReason: 'evidence' | 'insufficient_evidence' | 'no_witness_assertion' | null
  factors: Factor[]; capsApplied: Cap[]; notCorroborated: string[]; rubricVersion: 'v1'
}
score(input: ScoringInput, rubric = RUBRIC_V1): Assessment     // no I/O, no clock, no randomness
prioritize(classification, evidenceStatus, assessment, reviewState): 'high' | 'medium' | 'low' | 'needs_context'
```

All weights, caps and thresholds live in one frozen `RUBRIC_V1` object in `score/rubric.ts`. Every finding stores its `rubric_version` and `factors`, so any past score can be explained and reproduced.

**"Why this score?" in the UI.** The card shows "Assessment support 85/100, High (application-calculated, not a probability)". Expanding it shows a row per factor with points out of the maximum and an origin badge (Code, Claude, Code + Claude), the deductions and caps with their reasons, and a "not independently corroborated" list.

**Representative test cases (rubric v1)**

| # | Case | Calculation (A + C + S + K + U, then caps) | Expected | Proves |
| --- | --- | --- | --- | --- |
| 1 | Verified direct: "I was at the Bellevue office on March 3" against "I was not at the Bellevue office on March 3"; exact phrases, both answers clear | 20 + 10 + 30 (12+12+6) + 10 (negation asymmetry, shared anchor) + 25 = 95; no cap | **95 High**, priority high | Strong direct scores high |
| 2 | Inferential, different wording: "I never approved the PeopleSoft acquisition" against "I signed the final PeopleSoft term sheet"; one unestablished assumption (signing is approval); alternative explanation given | 20 + 10 + 25 (10+10+5) + 5 (shared anchor) + 15 = 75 | **75 High**, priority high | A paraphrase scores through Claude's validated inference |
| 3 | Strong inferential, no lexical corroboration: "I had nothing to do with approving that deal" against "I signed off on it myself"; same deal established by the surrounding lines; no assumptions, no alternative | 20 + 10 + 30 (10+10+10) + 0 + 25 = 85 | **85 High**, priority high | Missing corroboration is never a penalty |
| 4 | Compatible approximate times: direct, "I left around 8" against "I left at 8:05"; about timing; times compatible | 20 + 10 + 30 + 0 (compatible times are not a value conflict) + 20 (approximation word) = 80; timing cap 60 | **60 Medium**, priority medium | Compatible times never give a High direct finding |
| 5 | Yes affirms: "Did you approve the transaction?" / "Yes." against "I never approved that transaction" | Side A `question_affirmed`, clear. 20 + 10 + 30 + 5 (negation asymmetry) + 25 = 90 | **90 High**, priority high | A plain Yes adopts the question |
| 6a | No denies: "Did you approve the transaction?" / "No." against "I approved the transaction" | Side A `question_denied`, clear; the witness asserts "did not approve". 20 + 10 + 30 + 5 + 25 = 90 | **90 High**, priority high | A plain No is a denial, never agreement |
| 6b | No misread: "Did you approve the transaction?" / "No." against "I never approved it"; Claude calls it direct with `stanceA` = affirms | Stance mismatch, side A `not_adopted`. 12 (2+0+2+8) + 10 + 30 + 0 (both sides deny) + 25 = 77; cap 40 | **40 Low**, priority medium | Code catches a misread denial |
| 6c | Unclear answer: "Did you approve the transaction?" / "Not exactly. I reviewed the numbers." against "I approved the transaction myself"; alternative explanation given | Side A `question_other`, uncertain. 12 + 10 + 30 + 0 + 15 = 67; cap 70 applies but does not bind | **67 Medium**, priority medium | An ambiguous answer is never read as Yes |
| 7 | Qualified: "I think I approved the Hartley contract" against "I never approved the Hartley contract"; alternative explanation given | Side A qualified. 16 (2+4+2+8) + 10 + 30 + 10 (negation asymmetry, anchor) + 15 = 81; cap 70 | **70 Medium**, priority medium | Qualified testimony cannot reach High |
| 8a | No recall, classified direct: "Did you approve the transaction?" / "I don't remember." against "I approved the transaction"; Path A tagged side A `does_not_recall`, Claude said `asserted` | Side A `no_recall`. 12 + 10 + 30 + 0 + 20 (Path A disagreement) = 72; cap 40 | **40 Low**, priority medium | Failing to recall is not an assertion |
| 8b | Same pair, classified false positive (`uncertain_recollection`), side A labelled `does_not_recall` | 20 (code agrees with Claude on both sides) + 10 + 30 (15+15) + 5 (no-recall found) + 25 = 90; attribution caps do not apply | **90 High**, priority low | No recollection supports a false positive instead of capping it |
| 9a | Attorney statement: "Q: So you approved the Hartley contract in March." followed by an objection and a new question, against "I never approved the Hartley contract"; Claude calls it direct | Side A `not_adopted`. 12 + 10 + 30 + 5 (shared anchor) + 25 = 82; cap 40 | **40 Low**, priority medium | An attorney's words are not testimony |
| 9b | Both sides are attorney statements | Neither side clear or qualified | **No score**, priority needs\_context | The unscored rule |
| 10 | Incorrect exchange reference: the phrase is in a different exchange than cited | `wrong_reference` | **No score**, Unverified section, priority low | Invalid citations never score |
| 11 | Fabricated quotation: the phrase is found nowhere | `unsupported` | **No score**, Unverified section, priority low | Invented quotes never score |
| 12 | High-confidence false positive: "I got there around 8" against "I arrived at about 8:10"; `compatible_approximation`; times compatible | 20 + 10 + 30 + 10 (times compatible, approximation word) + 25 (the approximation deduction is for direct and inferential only) = 95 | **95 High**, priority low | Confidence and priority are separate |
| 13 | Direct with `sameEvent` = no | 20 + 10 + 18 (0+12+6) + 0 + 25 = 73; cap 25 | **25 Low**, priority needs\_context | Inconsistent model output is flagged |
| 14 | Every case above run twice, and with object keys reordered | Deep-equal `Assessment`, same `rubricVersion` | Identical | Determinism |
| 15 | Attribution cap matrix, direct and inferential: (clear, clear) none; (clear, qualified), (clear, uncertain), (qualified, qualified) 70; (clear, not\_adopted), (qualified, no\_recall) 40; (uncertain, uncertain), (uncertain, not\_adopted), (not\_adopted, no\_recall) unscored. The same matrix on a false positive applies no cap | Caps applied after the sum; the lowest applicable cap wins; each listed in `capsApplied` | As listed | Attribution caps apply correctly |
| 16 | A verdict containing `confidence`, `score`, `band`, `probability` or `certainty` | Strict schema rejects it; nothing scored; logged as a schema failure | Rejected | Claude never supplies a number |

Every expected value above was recomputed from the exact rubric; the tests assert the full `Assessment`, not only the total. The suite also runs property tests: the score stays between 0 and 100; removing a corroboration signal never raises the score; on direct and inferential findings, lowering either side's attribution level never raises the score; an inference step citing an ID outside the packet earns no step points; and every point in the total traces to a factor. A separate unit table for `readAnswer` covers "Yes.", "Yes, sir.", "Correct.", "No.", "No, sir.", "Never.", "Yes, but…", "I believe so.", "Uh-huh.", "Not exactly.", "I don't recall.", and a bare "No." to "You didn't sign it, did you?", using real Ellison answers where possible.

## Ask 3: Cost model

Cost is measured, not asserted. Every model call writes a row with its usage and price, and the app shows an estimated cost before an analysis and the actual cost during and after it. The figures below rest on planning assumptions about packet size, which the first real run replaces with measured numbers. The plan does not claim that two 300-page depositions cost less than $3 until a measured run supports it.

**What every call records** (`llm_calls`): job, pipeline stage, model identifier, input tokens, output tokens, 5-minute and 1-hour cache-write tokens (separately, since they are priced at 1.25x and 2x input), cache-read tokens, batch flag, attempt number, `price_version`, computed cost in USD, and timestamp. Prices live in a versioned table in code (`costs/pricing.ts`, USD per million tokens by model and token type, with an effective date). Cost is stored at call time, so a later price change never rewrites history.

**Built October 28.** `costs/` has the price table (Sonnet 5.5 and Haiku 5.5 from the pricing page, including Haiku 5.5's higher rates for prompts over 100,000 tokens, where the prompt counts cache reads and writes, and the Batch API's 50% off every token type), the pure `callCost()`, `recordCall()` and `jobCost()`. Every v2 model call is recorded with `recordCall()`; the models v2 calls are named per stage in `costs/models.ts`, and a test checks each has a price. A call to a model missing from the price table is still recorded with its tokens, as **unpriced** (`cost_usd` and `price_version` null), and is never counted as free: a job's total is unknown while any of its calls is unpriced, and the priced part is reported separately. `llm_calls.job_id` has no foreign key until the `jobs` table exists; that migration adds it after checking existing values. **The one known exception** is v1's `server/src/claude.ts`, which has no database and isn't recorded; v2 replaces it.

**Estimated versus actual**

- **Estimated cost** is shown after parsing and before any model call, with its assumptions on screen. Tagging cost = the deposition's measured tokens × the extraction price, plus an output allowance of 40% of input. Adjudication cost = calls × system-prompt and schema tokens (at the cache-read price after the first call) + pairs × packet tokens × input price + pairs × output tokens × output price. Packet and output tokens use the planning assumptions until a measured run exists, then the measured median and 90th percentile, shown as a typical and a high estimate.
- **Actual cost** is the sum of `llm_calls.cost_usd` for the job, broken down by stage, and updated live.

**Planning case (October 30).** Ellison, two sessions, 310 pages at 300 tokens per page (93K tokens), about 750 exchange parts. Card and topic figures are assumptions, not measurements. Adjudication uses the rate measured on analysis #11: $0.0063 per pair.

| Stage | Model | Input | Output | Cost |
| --- | --- | --- | --- | --- |
| Statement cards | Haiku | ~150K (31 chunks, prompts, one-page overlap) | ~75K | ~$0.05 |
| Topic map | Haiku | ~20K | ~10K | ~$0.01 |
| Pair adjudication | Sonnet | measured | measured | ~$0.0063 per pair |

The $3 ceiling is kept and shared across both paths: after cards and the topic map, it covers about 470 pairs at the measured rate, split about 60/40 as above. Multiple cards per exchange and secondary topics raise card output and candidate counts, so the first real run replaces these figures. A budget stop leaves the remaining candidates `selected` or `deferred`, and the ledger lists them. Topic-packet experiments have their own approved budget.

**Superseded planning figures.** The next paragraph describes the October 28 plan, kept for the record.

**What the 600 / 300 assumption may miss.** A packet carries two whole exchanges plus 5 context lines on each side, so a long answer (split at 40 lines) can double or triple the input. Each call adds a system prompt and the verdict schema. Output is the expensive side at $10 per million tokens: every extra 100 output tokens per pair adds $0.30 per 300 pairs, and the verdict's fields plus Claude's reasoning may well exceed 300. Retries are billed and logged with their attempt number. A stress case of 1,200 input and 700 output tokens per pair costs about $2.82 to adjudicate 300 pairs; with tagging ($0.07) and the audit sample ($0.19) that is about $3.08. The $3 ceiling would then stop the job at about 290 pairs, with status `partial_budget`, and the ledger would list the other 10 as not adjudicated (budget). Other sensitivities: 450 tokens per page raises tagging to about $0.10; Sonnet for tagging raises it to about $1.30; embeddings, if added, cost under $0.01 per deposition.

**Measured on Friday's first real run.** Each adjudication call records its input, output and cache tokens and how many pairs it carried; each candidate records its packet size in tokens, estimated from its characters and calibrated against the calls. System-prompt and schema tokens are measured once per prompt version with the token-counting endpoint. The README reports, per pair, the median, 90th percentile and maximum input and output tokens; the share of cost from system prompts; the retry count; and the resulting cost per 300 pairs. The estimator then switches from the planning assumptions to these measured values.

**Shared prompts and batching are counted once.** Cost is recorded per call, and a call's system prompt and schema are inside that call's input or cache-read tokens, so they are neither repeated per pair nor left out. Job totals sum calls, never pairs. A per-pair cost, where shown, is the call's cost divided by its pairs, for display only.

**Incremental cost has no fixed price.** Adding a deposition costs its own tagging, proportional to its pages, plus adjudication of the new pairs it creates against the witness's existing sessions. That depends on how many pairs rank above the budget. A first deposition for a new witness creates no same-witness pairs at all. The app estimates the increment before running and reports the actual after.

**The naive baseline, for the video.** Comparing every pair of 10 full depositions three times is 45 pairs × 180K tokens × 3 runs, about 24M input tokens. That is roughly $49 on Sonnet 5.5 or $97 on Opus 5.5 before output, and it grows with the square of the session count. v2 grows with page count plus the pair budget the user chooses.

**Cost controls**

- **Content-hash caching.** Same file, same parser and extractor version means no new model calls.
- **Incremental indexing.** A new session is compared against stored exchanges; old sessions are never re-read.
- **Candidate deduplication** across both paths, billed once.
- **Per-job budget, enforced.** Before each call the worker checks the call's maximum cost against what remains. The audit sample's estimated cost is reserved at the start, so a budget stop never skips the audit. If a call would exceed the budget, the job stops with status `partial_budget`, keeps every completed finding, and the ledger lists every selected candidate that was not adjudicated. Default ceiling: $3 for a two-session analysis, configurable.
- **Per-organization concurrency limit:** at most 2 running analysis jobs per organization, enforced through pg-boss queue keys.
- **Prompt caching** on the fixed system prompts, measured through cache-read tokens.
- **Batch API** (50% off) as an optional stretch feature.
- **Haiku triage** before adjudication, as a lever kept in reserve. It is built only if measured cost misses the target.

The under-$3 two-session figure is an engineering objective, not a promise. The demo and README show the measured number, whatever it is, and say whether the budget stopped the job.

## Ask 4: Backend for 1,000 to 5,000 users

The app stays fast because no user request ever waits on a model: analysis runs in separate workers, and every page the lawyer opens reads precomputed rows through an index. One Postgres instance with a connection pooler handles this load comfortably; the job is to prove it with a load test, not to add infrastructure.

**Sizing.** 5,000 users with perhaps 10% active at peak is 500 concurrent users. At one request every few seconds each, that is roughly 100 to 200 requests per second, almost all reads. Postgres serves indexed reads like these in single-digit milliseconds.

**Core choices**

| Choice | Why | Alternative considered |
| --- | --- | --- |
| Postgres with pgvector | One database for relational data, full-text search on lines and claim embeddings | A separate vector DB: more moving parts for no gain at this size |
| Job queue in Postgres (pg-boss) | Retries, concurrency limits and progress without adding Redis | BullMQ with Redis: fine, but one more service to run |
| API and workers as separate processes | A 20-minute analysis never blocks a dashboard request; workers scale on their own | One process: simpler, but the v1 problem at scale |
| PDFs in object storage (S3 or R2), rows in Postgres | The database stays small and fast | PDFs in the database: bloats backups |
| Connection pooler (PgBouncer or the host's built-in one) | Many API instances share a fixed number of DB connections | Direct connections: the usual way Postgres "falls over" under load |
| Express kept, TypeScript, zod at every boundary | Reuses v1 code and tests | Rewrite in another stack: no time |

**Rules that keep reads fast**

- Every table carries `org_id` and `case_id`, and every list query filters on an index that starts with them, for example `findings (case_id, priority, score DESC)`.
- Keyset pagination ("after this ID"), never `OFFSET` on large tables.
- Dashboard counts come from a `case_summary` row the worker updates when a job finishes, not from `COUNT(*)` on each load.
- Transcript lines load one page window at a time (`deposition_id, page`), never the whole deposition.
- Job progress via polling a tiny status row every 2 seconds, or server-sent events if time allows.
- Per-organization limits on concurrent jobs, so one heavy user cannot starve the model rate limit for everyone.

**Data model:** see the schema in the next section. Tenant isolation comes from `org_id` on `cases`, and every query joins through the case. Postgres row-level security is a stretch goal.

**Proof: a k6 load test.** Seed the database with synthetic volume: 5,000 users, 20,000 cases and about 5 million findings rows, so the indexes are actually exercised. Run 300 virtual users with 1 to 3 seconds of think time, about 150 requests per second, the estimated peak. They hit the dashboard, findings list and source-pane endpoints while an analysis job runs in the worker. Pass criterion: p95 under 500 ms with zero errors. Report p50, p95, error rate, request rate and the machine's specs, plus `EXPLAIN ANALYZE` for the slowest query. The README states what was tested (one machine, Docker) separately from projected capacity.

## Modules, schema and interfaces

This is a modular monolith: one TypeScript repo with an API process and a worker process sharing the same modules. Each module is a folder under `server/src` with one public entry point. Only `claims/` and `adjudicate/` call a model, and every such call goes through `costs/`.

| Module | Responsibility | Reuses from v1 |
| --- | --- | --- |
| `ingest/` | PDF (or DOJ HTML, the approved fallback) to `lines` to `exchanges`; records each deposition's source format; counts pages with no text layer (no OCR); idempotent rewrite per deposition | Nothing; replaces `transcript.ts` |
| `claims/` | Path A input: statement cards and the topic map with Haiku, card checks, coverage. Failure never blocks Path B. | `verify.ts` |
| `retrieve/` | `pathA.ts` (topic candidates), `pathB.ts` (full text), `union.ts` (dedupe, provenance, allocation, coverage), `audit.ts` (cross-topic sample) | Nothing |
| `adjudicate/` | Builds evidence packets, calls Sonnet, validates the verdict schema | `claude.ts` pattern, stop-reason checks |
| `verify/` | Layer 1 source checks and Layer 2 attribution levels, including the yes-or-no answer reader (`answers.ts`); pure functions | `quoteMatchScore`, `findQuoteElsewhere` |
| `score/` | `RUBRIC_V1`, score, attribution caps, bands, priority; pure functions, tests written first | `toBand` and `toPriority` ideas, `ambiguity.ts` |
| `costs/` | Price table, `recordCall`, estimator, budget guard | Nothing |
| `jobs/` | pg-boss queues, per-stage state and resume, ledger counts, per-org limits | Nothing |
| `api/` | Read endpoints, review actions, estimates | Error-handling style from `index.ts` |
| `eval/` | Scripts for recall@K per path, precision per band, citation validity, Q/A accuracy, cost | v1 answer keys |

**Interfaces between modules**

```ts
// ingest and index
ingest(depositionId: string): Promise<{ sourceFormat: 'pdf' | 'html'; pages: number; needsOcr: number[]; lines: number; exchanges: number }>
indexExchanges(depositionId: string): Promise<void>          // tsvector now; embeddings only when enabled
extractCards(depositionId: string): Promise<{ cards: number; rejected: number; coverage: Record<CoverageStatus, number> }>
buildTopicMap(witnessId: string): Promise<{ mapVersion: number; topics: number; unassigned: number }>

// retrieval: every path implements the same interface
interface CandidateSource {
  name: 'topics' | 'fulltext'
  find(witnessId: string, newDepositionId: string): Promise<RankedPair[]>
}
type PathBQueryMode = 'rare_terms' | 'all_terms'             // chosen by measured recall@K, not assumed
type RankedPair = { exchangeA: string; exchangeB: string; rank: number; signals: string[]; topicIds?: string[] }
unionCandidates(a: RankedPair[], b: RankedPair[], opts: { ceilingUsd: number; pathAShare: 0.6 }): Candidate[]
  // every input pair comes back once, with provenance and a status: selected | deferred | excluded

// adjudication and verification
buildPacket(c: Candidate): EvidencePacket      // both exchanges + 5 lines of context each, IDs, witness and session metadata
adjudicate(p: EvidencePacket, jobId: string): Promise<Verdict>        // production: adjudicate-v3, one pair per request
verifySource(v: Verdict, p: EvidencePacket): SourceCheck              // Layer 1, pure: verified | approximate | wrong_reference | unsupported
readAnswer(question: string, answer: string): 'affirms' | 'denies' | 'uncertain'   // Layer 2, pure; a plain "No." is never 'affirms'
checkAttribution(v: Verdict, p: EvidencePacket, claims?: Claim[]): AttributionCheck   // Layer 2 levels per side, pure

// scoring: pure, no I/O
score(input: ScoringInput, rubric = RUBRIC_V1): Assessment     // 0-100, band, factors, caps (see Confidence scoring)
prioritize(c: Classification, s: EvidenceStatus, a: Assessment, review: ReviewState): 'high' | 'medium' | 'low' | 'needs_context'

// costs
estimate(jobPlan: JobPlan, measured?: MeasuredProfile): CostEstimate   // planning assumptions until a measured profile exists
recordCall(jobId: string, stage: Stage, model: string, usage: Usage, attempt: number, items: number): Promise<void>
assertBudget(jobId: string, maxCallCostUsd: number): Promise<void>     // throws BudgetExceeded, so the job ends partial_budget
```

**Adjudication strategies.** Two are evaluated on the same pairs. Pair adjudication is the production default; topic packets are an experiment.

- **Pair adjudication (default):** one pair per request, `adjudicate-v3`, concurrency 10, as built.
- **Topic packets (experimental):** Sonnet receives a bounded group of related exchanges from one topic and returns a list of findings, each in the existing verdict shape. Each finding maps to a row in the candidate table, and is verified and scored exactly as a pair verdict is. The size limit is about 10 pages (7,000 tokens); a larger topic is split, and every split is counted.

```ts
type TopicVerdict = {
  findings: Verdict[]    // each: two exchange IDs from different sessions in this packet, classification and fields as today
}   // strict schema; experimental
```

Promotion needs acceptable recall, completeness and cost against pair adjudication on the same labelled pairs. The October 30 batching experiment is why: batches of 10 lost recall, omitted verdicts and returned placeholder explanations, and topic packets share that shape.

**Schema**

```sql
orgs(id, name)                          users(id, org_id, email)
cases(id, org_id, name)                 witnesses(id, case_id, name)
depositions(id, case_id, witness_id, taken_on, file_sha256, storage_key, source_format, page_count NULL,
            needs_ocr_pages int[], blank_pages int[], validation jsonb NULL, parser_version, status, ingest_error NULL, ingest_run)
            -- source_format: pdf | html; unique (case_id, file_sha256, parser_version)
            -- status: processing | ready | needs_review | unsupported | failed; validation: per-page status and failure reasons
            -- page_count and validation are null until the file is read; ingest_error is set only when failed
lines(id, deposition_id, pdf_page, printed_page, line_no, speaker, raw_text, norm_text)
exchanges(id, deposition_id, witness_id, group_id, part_no, kind, first_line_id, last_line_id,
          question_first_line_id NULL, question_last_line_id NULL, answer_first_line_id NULL, answer_last_line_id NULL,
          question_text, answer_text, dialogue_text, flags text[], tsv tsvector, embedding vector NULL)
          -- derived from lines: question_text and answer_text for retrieval, dialogue_text for model input
exchange_lines(exchange_id, line_id, role)   -- role: question | answer | context | unknown; primary key (exchange_id, line_id)
          -- tsv: generated from question_text and answer_text, GIN-indexed (Path B); content terms are counted
          -- at query time, not stored; embedding only if embeddings are switched on
-- entities: no table yet (approved October 28); normalized names live on each claim, alias resolution is backlog item 9
statement_cards(id, card_key, exchange_id NULL, cited_exchange, deposition_id, witness_id, extractor_version, ordinal, source_phrase NULL, first_line_id NULL, last_line_id NULL,
                statement, event, subject, entities text[], ungrounded_entities text[], predicate, object NULL, "time" NULL, location NULL, amount NULL,
                stance NULL, epistemic NULL, status, rejection_reason NULL, raw jsonb, llm_call_id)
                -- status: usable | rejected, with the reason; several cards may share an exchange
                -- card_key: stable across re-runs, unique per extractor version; raw: the model's card as received
                -- structured fields are null only on a rejected card that failed the schema
card_coverage(exchange_id, extractor_version, deposition_id, status, cards int, error NULL, llm_call_id NULL)
                -- status: carded | no_assertion | omitted | failed | not_processed; primary key (exchange_id, extractor_version)
topics(id, witness_id, map_version, name, sessions int, is_unassigned bool, llm_call_id NULL)
                -- sessions: how many depositions it spans; one is_unassigned topic per map version
card_topics(topic_id, card_id, map_version, is_primary bool)  -- primary key (topic_id, card_id); one primary per card per map_version
packets(id, job_id, topic_id, part_no, exchange_ids int[], packet_tokens int NULL, status)   -- topic-packet experiments only
claim_tagging(exchange_id, extractor_version, deposition_id, status, claims, error NULL, llm_call_id NULL)
       -- historical (Path A claims): one row per part attempted; preserved, with the `claims` table, for existing results
candidates(id, job_id, witness_id, deposition_a, group_a, deposition_b, group_b, exchange_a, exchange_b, sources text[],
           rank_topics int NULL, rank_fulltext int NULL, evidence jsonb, retrieval_version NULL, map_version NULL,
           selected_by NULL, status, deferred_reason NULL, exclusion_reason NULL)
           -- the one canonical pair table, extended additively; historical rows and benchmark results are preserved
           -- sources: path provenance, Path A, Path B or both; status: see "Candidate pool and selection"
           -- job_id is the analysis; the prompt version lives on verdicts, so neither is repeated here
candidate_topics(candidate_id, topic_id)                      -- the topics a Path A candidate was found through; primary key (candidate_id, topic_id)
verdicts(id, candidate_id, packet_id NULL, model, prompt_version, raw jsonb, created_at)        -- the model's output, kept as received
findings(id, case_id, candidate_id, verdict_id, type, evidence_status, attribution_a, attribution_b,
         score int NULL, band NULL, factors jsonb, caps jsonb, rubric_version, priority, review_state)
         -- attribution_a/b hold the combined level: clear | qualified | uncertain | not_adopted | no_recall
reviews(id, finding_id, user_id, decision, note, created_at)                    -- human decisions, apart from AI output
jobs(id, case_id, status, budget_usd, spent_usd, counts jsonb, error)
     -- status: queued | running | partial_budget | partial_failed | complete | failed
job_stages(job_id, deposition_id, stage, status, attempts, input_hash, completed_at)  -- unique (job_id, deposition_id, stage)
llm_calls(id, job_id NULL, stage, model, items int, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
          batch bool, attempt, thinking_tokens NULL, raw_output NULL, price_version NULL, cost_usd NULL, created_at)     -- items: cards, card lines or packet exchanges, by stage
          -- price_version and cost_usd are null together for a model missing from the price table (unpriced, never free)
-- evaluation labels: not a table; a versioned JSON file under data/eval/, anchored by file SHA-256 and page:line (see Evaluation method)
case_summary(case_id, counts jsonb, cost_usd, updated_at)
```

`llm_calls.items` counts cards, card lines or packet exchanges, by stage. Add `statement_cards` and `topic_mapping` to the stages in `costs/models.ts` (Haiku).

**Indexes:** `lines (deposition_id, printed_page, line_no)` unique; `exchanges (witness_id, deposition_id)`; GIN on `exchanges.tsv` (added with Path B); `statement_cards (witness_id, deposition_id, status)`; `card_topics (card_id)`; `candidate_topics (topic_id)`; `candidates (candidate_set, deposition_a, group_a, deposition_b, group_b)` unique; `findings (case_id, review_state, priority, score DESC, id)` for the navigator; `llm_calls (job_id, stage)`. HNSW on `exchanges.embedding` only once embeddings are switched on.

**Failure and resume.** Every stage writes `job_stages` keyed by job, deposition and stage, with the hash of its inputs. pg-boss retries a failed stage 3 times with exponential backoff, then marks it failed and the job `partial_failed`. Completed findings stay visible behind a "partial analysis" banner. A re-run skips stages whose input hash already completed, and source records cannot duplicate thanks to the unique keys above.

**API**

- `POST /cases/:id/depositions?witness=&takenOn=` with the PDF as the request body (built October 28): 202 with the new deposition, `processing`; 200 with the existing one if the file is already in the case. `GET /depositions/:id` returns its status, page counts, reasons and stored counts. `POST /depositions/:id/retry` re-queues a `failed` deposition.
- `GET /cases`, `GET /cases/:id/summary` (one row, including the ledger and cost)
- `GET /cases/:id/findings?cursor=&type=&band=&priority=&review=&evidence=` (keyset pagination)
- `GET /exchanges/:id` and `GET /depositions/:id/lines?page=&around=` (one window of source lines)
- `POST /findings/:id/review` with `confirmed`, `dismissed` or `needs_context`, plus a note
- `GET /cases/:id/estimate?pairs=`; `POST /cases/:id/analyses` with `{ maxPairs, budgetUsd }` returns a job ID
- `GET /jobs/:id` returns stages, ledger counts, and estimated versus actual cost

## Evaluation method

A small, carefully labelled set, with retrieval and classification measured separately and the number of examples printed next to every metric. Nothing here supports a claim of broad legal reliability, and the README will say so.

**Real testimony (Ellison P3171 and P3173).** Label exchange pairs in these categories: potentially contradictory, related but compatible, different events, ambiguous, qualified, lack of recollection, and relevant pairs that retrieval should surface whatever their label. Target about 40 labelled pairs, with no quota for contradictions. If only three genuine ones exist, the set has three. Labels go in a versioned JSON file under `data/eval/` (approved October 28), not a table keyed by exchange IDs, since those IDs change on every re-ingestion. Each label identifies its two passages by the deposition PDF's SHA-256 and printed page:line, has a label from the categories above and a short explanation, and is resolved to exchanges when the evaluation runs (a page:line inside any part of a split long answer resolves to that part). The file holds references and short notes, not transcript text. Time box: 2 to 3 hours on Thursday, finding pairs with Path B's search.

**Synthetic regression fixtures.** The v1 Marcus Webb and Elena Ruiz sets with their answer keys, plus about 8 adversarial cases written for v2: a "don't remember" trap, a phrase that appears only in the attorney's question, a plain "No." that a careless reader could take as agreement, a "Yes." that adopts the question, the same time but different events, a paraphrased contradiction ("never authorized" against "gave final approval"), a citation to the wrong exchange, and a fabricated quote. Stored with `is_synthetic = true` and always reported separately.

| Metric | Definition | Data |
| --- | --- | --- |
| Q/A reconstruction accuracy (PDF parser) | Share of sampled exchanges whose boundaries, text and page:line from the PDF match the DOJ HTML version; reported even if the demo uses the HTML fallback | At least 20 exchanges from the spike, at least 60 by the final run |
| Source citation validity | Share of findings whose cited lines resolve and render text identical to the source | Every finding produced |
| Retrieval recall | Share of labelled relevant pairs found, per path and together, and how many were assessed within the budget | Real labels |
| End-to-end discovery | Known contradictions found by the full retrieval run among distractors, with no pair selected by hand | Synthetic and real, reported separately |
| Card coverage | `qa` parts by coverage status, and cards rejected by reason | Each run |
| Path B query mode | Recall@K for rare-term queries against all-meaningful-term queries, on the same labels and K | Real labels |
| Path contribution | Labelled pairs found by only one path | Real and synthetic |
| Classification precision | Of findings classified direct or inferential, the share labelled potentially contradictory; per band | Real and synthetic, reported separately |
| False-positive handling | Of adjudicated compatible or different-event pairs, the share classified false positive or needs more context | Real and synthetic |
| Uncertainty handling | Of adjudicated no-recall, qualified or ambiguous pairs, the share not classified direct | Real and synthetic |
| Cost per analysis | Actual cost by stage from `llm_calls`, with per-pair input and output token distributions | Each real run |
| Topic co-membership recall | Share of labelled retrieval-relevant pairs whose two exchanges share any topic | Real labels |
| Topic purity (spot check) | In 10 random topics, the share of members a reviewer agrees are about that topic | Manual, n = 10 topics |
| Map misses found by audit | Findings from the Path B audit sample, i.e. pairs the map split. Reveals misses; doesn't prove recall | Each run |
| Topic-packet strategy | Recall, missing verdicts and cost against pair adjudication on the same pairs; packet splits | Experiments only |

Recall@K for Path B stays, for comparison.

**Labels are separate from model output.** The real set targets 20 to 40 pairs by October 31. Each pair is labelled direct contradiction, inferential contradiction, compatible, insufficient evidence, or uncertain / needs expert review, and records whether the two statements are genuinely comparable. If that many reliable labels can't be finished, a smaller set is used and the limitation reported.

**Improved recall is never claimed from manually selected pairs alone.** The evaluation includes end-to-end retrieval tests where the system must discover known contradictions among distractors, with no pair chosen for it. Results are reported per path, with n, and synthetic results separately.

## Acceptance criteria

| Area | Criterion | How it is shown |
| --- | --- | --- |
| Real depositions | Genuine sworn testimony (both Ellison sessions, P3171 and P3173) is ingested and analyzed end to end, and the case page and README name the source format used (PDF or DOJ HTML) | Ledger counts on the case page; README |
| PDF ingestion | Claimed only if the chosen parser reproduces at least 99% of sampled lines with the correct page:line on real DOJ PDFs. Otherwise the README says the demo used DOJ HTML and reports the PDF parser's measured accuracy and failure types | Spike report; Q/A accuracy metric |
| Ingestion | Exchanges keep their source references, including multi-page exchanges | Q/A accuracy metric, at least 60 exchanges |
| Ingestion | Pages without a text layer are reported, never silently dropped (no OCR) | Test with a page that has no text layer |
| Retrieval | Both paths produce candidates, and Path B works with statement cards switched off | Test run with `extractCards` disabled |
| Retrieval | Path B query mode (rare terms or all meaningful terms) chosen by measured recall@K; recall@K reported per path; target 80% at K = 300 | Eval script output with n |
| Retrieval | Every candidate has an explicit status (`selected`, `adjudicated`, `deferred`, `excluded` with a reason, or `audit`); provenance recorded; a candidate found by both paths billed once | Ledger; union tests |
| Adjudication | Claude receives compact packets and returns IDs; displayed quotes come from the database | Code review and a test that rejects free text |
| Adjudication | Invalid references never become verified findings | Tests 10 and 11; synthetic fixtures |
| Adjudication | Ambiguous or no-recall statements are not classified direct | Uncertainty metric and the "don't remember" fixture |
| Attribution | A plain "No." is never read as affirming the question; ambiguous, qualified or nonresponsive answers stay uncertain; attribution caps apply to direct and inferential findings after the sum, and not to false positives | Tests 5 to 9 and 15; `readAnswer` unit tests |
| Scoring | Evidence status, score and priority are separate, deterministic and explained | Scoring suite (16 required cases, 20 with variants) and the "Why this score?" panel |
| Scoring | Scoring tests are committed before `score()` is implemented, and the function reproduces every expected value in the test table | Git history; CI |
| Scoring | The time check applies only to timing conflicts. Claude never supplies a number (strict schema). High-confidence false positives get low priority. High is more precise than Medium on the labelled set, reported with n | Tests 4, 12 and 16; eval script |
| UI | Selecting a finding shows both passages with page:line, expandable context, and review actions | Demo video |
| Cost | Every model call is logged; actual cost is visible; budgets are enforced; a budget stop lists every candidate not adjudicated | Budget-exceeded test with a $0.20 limit |
| Cost | Per-pair input and output token distributions measured on the first real run; two-session cost reported as measured, with no under-$3 claim before that | README |
| Scalability | AI work is asynchronous; dashboards read indexed, precomputed rows | k6 run with a job active: p95 under 500 ms, 0 errors at 300 virtual users |
| Scalability | README separates tested numbers from projected capacity | README |
| Reliability | A worker killed mid-job resumes without duplicating source records | Kill test, row counts before and after |
| Reliability | A fresh clone runs with one command | Tuesday check |

## Ask 1: A UI a lawyer reads at a glance

The core screen is the Contradiction Workbench. A findings navigator sits on the left. On the right, the two testimony passages appear side by side, each scrolled to its page:line and highlighted, with the assessment underneath. A lawyer never has to open a PDF to check a finding. Passages are rendered from the stored lines (line numbers 1 to 25 in the margin, monospace), which is exact by construction.

**Core screens**

1. **Cases dashboard.** One row per case: witnesses, sessions, pages, indexing status, counts by classification (direct, inferential, false positive, needs more context, unverified), review progress, and analysis cost. Loads from `case_summary` only and never waits on a model.
2. **Case overview.** Sessions per witness with their dates and source format (PDF or DOJ HTML), job progress by stage, a "partial analysis" banner when a job stopped on budget or failure ("Partial: 290 of 300 pairs adjudicated, budget reached"), and the coverage ledger: pages parsed and failed, exchanges indexed, claim batches done and failed, candidates generated, deduplicated, adjudicated, deferred, excluded (with reasons), awaiting assessment and audited, by path, findings verified, and estimated versus actual cost. It says plainly that full processing is not proof that every contradiction was found.
3. **Contradiction Workbench.**
   - **Navigator (left):** search; filters for classification, band, priority, witness, session, evidence status and review state; each row shows a type chip with a text label, both citations (like `Ellison 1/20/04 p.148:15 vs P3173 p.130:20`) and review state.
   - **Passages (right, side by side):** earlier session left, later right. Each shows the full exchange (question and answer) with the cited lines highlighted, about 10 lines of context, "show more" to scroll the whole transcript, and "Open original at p. N" to open the PDF at that page.
   - **Assessment (below):** the evidence status badge (decided by code); each side's attribution; Claude's explanation and alternative explanation, labelled as Claude's; the score as "82/100, High", labelled as application-calculated and not a probability; a "Why this score?" breakdown with each factor's points out of its maximum, marked Code, Claude or both, plus deductions, caps and what was not corroborated; and the priority; and the time-check detail when it applied.
   - **Review:** unreviewed, confirmed, dismissed, or needs more context, plus a note. Stored apart from the AI output.
4. **Unverified section.** `wrong_reference` and `unsupported` findings in a dashed section labelled "Check manually", with the reason, as in v1.

**Design rules.** Type is shown by colour and a text label, never colour alone. Model output is always labelled as Claude's; code checks are labelled as checks. Citations use page:line, the format lawyers already use. The app never states that a witness is lying or draws legal conclusions. Built with Tailwind and shadcn/ui components so the agents produce a consistent, accessible UI quickly. Keyboard shortcuts, export and the witness timeline are in the stretch backlog.

## Test data: real public depositions

The primary real testimony is Larry Ellison's two DOJ deposition transcripts, P3171 and P3173: one witness, two sessions, 310 pages with a text layer and 22 numbered lines per page. P3173 refers to the earlier deposition as taken on January 20, 2004, which matches P3171, and was taken later that year. Both are designated excerpts with redaction gaps. The Gates depositions were the original pick, but their public PDFs are scans with no text layer, so they are kept only as the documented image-only case. Verified in `docs/parser-spike.md`. Add one multi-witness case second.

| Source | What it tests | Where | Notes |
| --- | --- | --- | --- |
| Larry Ellison, Oracle, DOJ exhibits P3171 (January 20, 2004) and P3173 (later in 2004) | Same witness in two sessions; 211 + 99 pages; non-contiguous excerpts | [P3171](https://www.justice.gov/atr/p3171-cid-022793-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript), [P3173](https://www.justice.gov/atr/p3173-cid-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript) | Primary pick. Text-layer PDFs, with DOJ HTML versions used as the parser cross-check. Designated excerpts with "\[Non-designated testimony redacted\]" gaps. Subject overlap is partial (Microsoft, SAP, IBM, pricing and scale are shared); genuine contradictions are not assumed. P3173's exact date is not stated in the transcript. |
| Bill Gates, *U.S. v. Microsoft*, excerpts as admitted in court | Image-only PDF limitation | [DOJ Antitrust Division page](https://www.justice.gov/atr/cases/ms_gates2.htm) | Not processed. 5 scanned PDFs, 109 pages, none with a text layer; ingestion would mark every page `needs_ocr`. OCR is out of scope for v2. |
| *New York v. Trump* civil fraud case | Many witnesses, a known false statement | [Trump deposition, April 13, 2023 (PDF)](https://uploads-ssl.webflow.com/66c4fcffeb606e663284c300/66c4fcffeb606e663284c56c_Trump%20-%204_13_2023%20-%2020240227031940.pdf) | Allen Weisselberg [pleaded guilty to perjury](https://www.bostonglobe.com/2024/03/04/nation/key-figure-trumps-business-pleads-guilty-felony-perjury) over testimony in this case. Whether his deposition transcript is public is **unknown**. Stretch only. |
| CourtListener RECAP archive | Finding more | [Guide to searching RECAP](https://law-arizona.libguides.com/az/court-listener-recap-archive) | Federal filings often attach deposition excerpts as exhibits. |

These are real documents, not labelled benchmarks. The Evaluation method section explains how they are labelled. The v1 Marcus Webb and Elena Ruiz sets stay as synthetic fixtures, always reported separately from sworn testimony.

## Build plan to November 3

The key milestone stands: the full pipeline runs end to end on real deposition material by Friday, October 30. The order follows the priorities: correct evidence, then retrieval, adjudication, UI, measured cost, and scalability. Stretch features start only once every acceptance criterion passes. Each day ends with a merged pull request and a working app.

**How to lean on the agents (and show it)**

- Commit `CLAUDE.md` (stack, commands, conventions, "never call the model from the client", "every quote passes the evidence gate") and `DESIGN.md` (this doc, trimmed) on day one, so every agent session starts with the same context.
- One feature per branch and pull request. Start each in plan mode, approve the plan, then let the agent write the code and its tests.
- Run two agents in parallel in separate git worktrees on independent tracks, for example the UI on mocked data while another builds the pipeline.
- Use an independent Claude review agent (`.claude/agents/evaluator.md`) as a second reviewer on each pull request, and a hook that runs `npm run typecheck` and `npm test` before every commit.
- Keep `docs/agent-log.md`: the prompt, what the agent got wrong, what you changed. The v1 `tq_id` story shows Edward this is the skill he is hiring for.

**Day by day**

- [x] **Tue Oct 27:** repository audit and design (done).
- [x] **Wed Oct 28, morning: parser spike, decision by 1 p.m.** (done October 27) Commit `CLAUDE.md` and `DESIGN.md`. Get one deposition PDF and its DOJ HTML version (done on Ellison P3171 and P3173; see `docs/parser-spike.md`). Parse representative pages and rebuild at least 20 exchanges, including a multi-page exchange and short answers. Compare text and page:line against the HTML, list the formatting failures, and choose TypeScript or the PyMuPDF utility by the rule in Ingestion. If neither passes, switch the demo input to the DOJ HTML transcripts (approved fallback) and keep the PDF results for the README.
- [ ] **Wed Oct 28, afternoon:** Docker Compose (Postgres with pgvector), Drizzle schema and migrations, `ingest/` for lines and exchanges with fixture tests (CLI ingestion for now; the pg-boss worker with `job_stages` and the upload endpoint move to the next stage, approved October 27, and remain required), `costs/` price table and `recordCall` (no model calls yet). *End of day:* both Ellison depositions ingested from the CLI as `ready`, with their lines and exchanges in Postgres.
- [ ] **Thu Oct 29:** Path B full-text retrieval first, in both query modes, so candidates exist without any claims. Then Path A: claim tagging with epistemic status, key-phrase checks, structured retrieval. Then `merge.ts` (RRF, configurable cap, budget, deferred, audit sample). You label the real evaluation set (2 to 3 hours) while an agent writes the synthetic adversarial fixtures. *End of day:* ranked candidates for Ellison P3171 and P3173, with recall@K per path and per Path B query mode on the first labels, and the cap-effect numbers.
- [ ] **Fri Oct 30 (evening):** baseline commit and restore-checked backup (done); this revision in `DESIGN.md`; isolate v1 into one folder, still running; remove import cycles; additive migration for cards, coverage, topics and candidate fields; label review sheets.
- [ ] **Sat Oct 31:** statement cards in `claims/` with pure tests, then cards for both Ellison sessions; multi-membership topic map; Path A candidates; candidate union with provenance and 60/40 allocation; 20 to 40 labels. *End of day:* both paths produce one pool, with coverage counts.
- [ ] **Sun Nov 1:** analysis jobs on the new pool; proof that existing scores are unchanged; evaluation and end-to-end discovery tests; live pair run; Path B audit; topic-packet experiment if time and budget allow.
- [ ] **Mon Nov 2:** frontend rebuilt around the final workflow, using the Impeccable and Taste skills; review actions; k6 and the kill test; full-system testing.
- [ ] **Tue Nov 3:** stabilization, fresh-clone check, README and video, submit. v1 is deleted only after validation and explicit approval.

## Risks and fallbacks

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| PDF parsing misses lines or page:line on real files | Medium | Approved fallback: ingest the DOJ HTML transcripts for the demo. The README and video say the demo ran on HTML and report the PDF parser's measured accuracy separately; HTML success is never presented as PDF parsing. |
| Path B returns too many weak pairs, or misses paraphrases | Medium | Ranked within its share of the budget, and unassessed pairs stay counted; Path A catches paraphrases through statement cards; embeddings only if measured recall justifies them. |
| Few genuine contradictions in Ellison P3171 and P3173 | High | Real labels still measure retrieval, false-positive handling and uncertainty. Precision on contradictions also comes from synthetic fixtures, reported separately with n. |
| Adjudicator misreads attribution, including yes-or-no answers | Medium | Code reads plain yes and no answers itself; the lower of the code's and Claude's reading wins; a stance mismatch or a no-recall answer caps the score at 40. |
| The answer reader is too strict or too loose (tag questions, compound questions, "Uh-huh") | Medium | Anything other than a plain yes or no stays uncertain (cap 70, never High). Unit tests use real Ellison answers. Compound questions ("Did you read and approve it?") are a documented limit. |
| Packets and outputs are larger than planned, so cost overshoots | Medium | Measured on Friday; the budget guard stops with a disclosed partial status; then lower the ceiling or context lines, or use the Haiku triage lever. |
| Workbench UI takes longer than Saturday | High | A plain findings list exists from Friday; stretch UI features wait. |
| Load test machine limits | Medium | Run locally in Docker, publish the machine specs, and label results as tested on one machine. |
| The topic map splits one event across two topics, so a real pair is never compared | Medium | Secondary memberships and Path B reduce it; the audit sample reveals misses; merge near-duplicate topics by embedding the `event` lines if it happens |
| A topic is too large for one packet (experiment only) | Medium | Split by time, then page order; splits counted and shown |
| Candidate volume exceeds the ceiling | High | The 60/40 allocation and explicit coverage: what isn't assessed is reported, not hidden |
| Removing old claims changes scores through the extraction-disagreement check | Medium | Prove existing scores are unchanged before any claims code is removed |
| The redesign is not finished by Sunday night | Medium | The pair pipeline from analysis #11 stays in the repo and working; the demo uses whichever pipeline ran end to end, and says which |

**Never cut:** page:line provenance, the Layer 1 gate, both retrieval paths, the token and cost log, budget enforcement, the evaluation with n, and the k6 numbers.

## Stretch backlog

None of these start before every acceptance criterion passes. They are ranked by value relative to time. Employer criteria: 1 = UI, 2 = real depositions, 3 = cost, 4 = load.

| Rank | Feature | Effort | Depends on | Product value | Technical risk | Criteria |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Keyboard shortcuts (J/K to move, C/D/N to review) | 1 to 2 h | Workbench | Medium: faster review, a polished demo | Low | 1 |
| 2 | Skeptical second-opinion adjudication on borderline findings | 3 to 4 h | Adjudication, scoring. A skeptic's disagreement becomes a 10-point deduction and agreement adds nothing, so confidence never depends on how many calls ran. | High: more defensible Medium and Low findings | Medium: prompt design, about 20% more adjudication cost | 2, 3 |
| 3 | CSV or printable findings export with page:line | About 2 h | Findings API | Medium-high: lawyers paste citations into briefs | Low | 1 |
| 4 | Hosted deployment (only once local Docker is reliable) | 3 to 5 h | Working Docker stack | High for the demo: Edward can click a link | Medium: environment, secrets, managed Postgres | 4 |
| 5 | Witness claim timeline | 4 to 6 h | Claims, Workbench | Medium-high: preparing cross-examination | Medium: depends on claim quality | 1, 2 |
| 6 | Server-sent events for job progress | 2 to 3 h | Jobs | Low-medium: polling already works | Low | 1, 4 |
| 7 | Additional date and temporal checks | 4 to 6 h | `ambiguity.ts` | Medium: dates are common in real conflicts | Medium: date-parsing edge cases | 2 |
| 8 | Anthropic Batch API integration | 3 to 4 h | Adjudication, jobs | Medium: halves adjudication cost, but results can take hours | Medium: asynchronous result handling | 3 |
| 9 | More advanced entity resolution | 6 to 8 h | Claims | Medium: better Path A recall | High: hard to validate in time | 2 |
| 10 | Cross-witness discrepancy analysis | 8 h or more | Both paths, new labels | High as a product, but new scope | High: new retrieval scope and evaluation | 2 |

## Implementation notes: adjudication as built (October 29)

This section describes the code as built. It is not part of the frozen specification above. Rubric v1 (weights, caps and bands) is unchanged. Each deviation from the specification is listed under "Deviations".

**Budgets (`costs/budget.ts`).**
- Budgets and their reservations are stored in Postgres.
- **Before a call is sent, its worst case is reserved in one conditional update.** Input is bounded at one token per character, priced at the cache-write rate. Output is priced at the configured `max_tokens`, which caps thinking and the verdict together. Concurrent reservations can't overspend.
- **After the call:**
  - a response is settled at its recorded cost;
  - a 4xx error is released, because it wasn't billed;
  - a timeout, 5xx or lost connection is counted in full as uncertain;
  - a reservation left open by a crash is reconciled as uncertain.
- SDK retries are off, so every attempt reserves its own cost.
- Path A tagging and adjudication both use this mechanism.

**Packets (`adjudicate/packet.ts`).**
- A packet holds the whole logical exchange from the stored lines, plus up to 5 context lines on each side, the witness, and the session dates. It carries no retrieval signals.
- Context stops at a page skip, since excerpted exhibits omit page ranges, and the packet says pages are omitted.
- The packet's line IDs are stored with its verdict.

**The call (`adjudicate/model.ts`, `run.ts`).**
- One Sonnet 5.5 call per packet: prompt `adjudicate-v1`, the strict `Verdict` schema, effort `medium` by default (configurable), `max_tokens` 8,000.
- Every response is recorded with its effort and latency. Its verdict is stored as received: `valid`, `schema_invalid`, `refused` or `cut_off`.
- Every valid verdict produces a finding, scored or not.

**Layer 1 (`verify/source.ts`): additions to v1's matching.**
- **An approximate match must be found within one sentence, with the same negation words as that sentence.** v1's word-share match accepted negation flips and words gathered from different sentences.
- **A phrase that matches better outside the cited exchange is a wrong reference.**
- **A key phrase that is only an answer ("Yes.", "Yes, they do.", "I don't recall.") stands for the question it answers.**
  - The question and answer are read together, and the question becomes the side's proposition for code's checks.
  - The evidence lines are the question and the answer, never a lone "Yes" or "No".
  - A bare answer with no question in its exchange is unsupported.
- **Compound questions.** When the key phrase cites only part of the question:
  - a plain "No." to "A and B?" doesn't deny each part;
  - a plain "Yes." to "A or B?" doesn't adopt either part.

  Either answer leaves the side uncertain.

**Layer 2 (`verify/attribution.ts`).** Code's reading has a scope:
- **exact:** a plain yes or no, a whole no-recall answer, or a phrase only in an attorney's words. Code's reading stands, whether Sonnet overstated or understated it.
- **upper bound:** a hedge (at most qualified), or conditional wording or an answer that isn't plain (at most uncertain).
- **none:** the witness's own words, where code found nothing. Sonnet's reading stands there.

Disagreements are recorded on the side. `readAnswer` accepts explicit denials and affirmatives ("No, never.", "Of course."), including elaboration that keeps the same direction and doesn't hedge or limit it. The hedge list adds "might have", "may have", "maybe", "perhaps", "possibly", "as far as I know/recall" and "if I recall". A hedge that is quoted, negated, or inside someone else's reported words doesn't count.

**Scoring and priority (`score/`).**
- `RUBRIC_V1` is frozen, and the 16 cases above pass with their exact values.
- A valid false positive keeps its score-based priority when Sonnet asks for context. The request is stored as `findings.context_requested`. Mandatory context review stays for direct and inferential verdicts that need context, insufficient evidence, unscored findings, and the same-event inconsistency.

**Cost estimate.** The worst case is the reservation above. The expected cost comes only from measured calls of the same prompt version.

**Prompt versions and consistency.**
- **Prompts are versioned** (`adjudicate-v1`, `adjudicate-v2`), and verdicts are kept per version. A new version runs beside the old one; repeating the same version is refused unless asked for. The default stays v1 until v2 is approved.
- **v2's changes:**
  - a qualified statement can still contradict;
  - a hypothetical reconciliation is kept as an alternative explanation instead of dismissing the conflict;
  - `alternativeSupport` (established, plausible or speculative) is added to the schema;
  - `conflictBasis` is `none` for false positives.
- **Consistency check (`adjudicate/consistency.ts`).** A schema-valid verdict whose categorical fields contradict each other is stored as received, with its issues in `verdicts.consistency_issues`. Its finding is unscored (`inconsistent_verdict`) and goes to review. It is never converted or retried. The explanation text isn't parsed.

**Deviations from the specification:**
- Candidates belong to a named `candidate_set` until analysis jobs exist.
- Budgets are standalone tables, not `jobs.budget_usd`.
- One pair per call, not 10.
- Layer 2 is bounded rather than "the lower of the two readings": an exact code reading can raise a level that Sonnet understated.
- False positives with `needsMoreContext` aren't routed to `needs_context` (approved October 29).
- `SideAttribution` adds `approximation`, `codeBound`, `codeRule` and `disagreement`.
- A semantically inconsistent verdict is unscored before scoring (`inconsistent_verdict`), a gate the specification doesn't have. Direct with `sameEvent` "no" keeps the rubric's cap of 25 instead.
- The false-positive "different anchors" check compares dates only.

**Product workflow (October 30).**
- **Analyses.** The `analyses` table (migration 0011) holds one comparison of two sessions of a witness: mode, budget, status, stored progress counts and errors. Status runs queued, parsing, retrieving, adjudicating, then completed, or stops as failed, blocked_budget or blocked_credentials.
- **Jobs.** The pg-boss queue `run-analysis` (singletonKey per analysis, 2 retries, dead letter) runs `jobs/analysis.ts`:
  - waits for both depositions to be read;
  - retrieves with Path A (stored claims only) and Path B, kept to the pair;
  - saves the candidates as the set `analysis-<id>` (their `job_id` is the analysis);
  - adjudicates in rank order. A re-run continues where it stopped and never adjudicates a candidate twice.
- **Live mode** needs `ANTHROPIC_API_KEY` and `ALLOW_PAID_CALLS=true`; otherwise the analysis stops as blocked_credentials before any call. It stops as blocked_budget before any call the budget can't cover, and fails after 3 consecutive call failures. Blocked and failed analyses can be resumed, optionally with a larger budget.
- **Demo mode never calls a model.** It replays a stored valid model verdict for the same pair of exchanges (`verdicts.origin = 'replayed'`, `replay_of`), or a synthetic fixture's prepared verdict (`origin = 'fixture'`), through the same `storeVerdict()` as a live call, so checks and scores are recomputed by current code. Each finding's source is shown in the UI.
- **The review app** groups findings into four sections: potential contradictions, likely compatible, insufficient evidence, needs your review. It shows both passages verbatim from the stored lines with highlights, and labels the score as assessment support.

**Further deviations (October 30):**
- Analyses replace the planned `jobs` and `job_stages` tables, in simplified form.
- Demo mode and verdict origins aren't in the specification.
- New uploads aren't claim-tagged (paid), so their Path A is empty.
- The default prompt is still adjudicate-v1 pending approval.

## Decisions (approved October 28)

All four previously open decisions are approved. Planning is complete, and implementation starts with the Wednesday parser spike.

- [x] **Rubric v1, approved provisionally.** It includes the attribution caps, yes-or-no handling and recomputed test values in Confidence scoring. Weights, caps and thresholds are frozen for the initial evaluation; any later change ships as a new, explained rubric version.
- [x] **Default budgets.** 300 adjudicated pairs, a $3 maximum per two-session analysis, and 20 deferred pairs sampled for audit. All configurable, and revisited against measured token use and retrieval coverage.
- [x] **Parser fallback.** Use the DOJ HTML transcript when PDF extraction misses the source-fidelity threshold, and document the limitation openly.
- [x] **Pair scope.** Same witness across different deposition sessions only. Within-session contradictions and cross-witness discrepancies stay out of the core build. *Cross-witness analysis was added on November 3, 2026, on the developer's instruction, by direct discovery only: see "Implementation note: cross-witness analysis".*
- [x] **Hybrid retrieval (approved October 30; replaces the first topic-map draft).** Multiple statement cards per exchange, a multi-membership topic map, Path A and an independent Path B feeding one deduplicated candidate table. Production stays `adjudicate-v3`, one pair per request, concurrency 10; topic packets are experimental. The pair pipeline stays until the new system passes end-to-end evaluation. v1 is deleted only after validation and explicit approval.
- [x] **Budget (approved October 30).** A shared dollar ceiling with explicit coverage accounting; about 60% to Path A and 40% to Path B for the first experiment, redistributing unused capacity. This replaces the 300-pair default above.
- [x] **Candidate storage (approved October 30).** One canonical pair table, extended additively; historical candidates and benchmark results are preserved.

**Testing budget.** About $30 of Anthropic API use during development, tracked through `llm_calls` and checked daily, with every job under its own budget guard.


## Implementation note: adjudication execution (October 30, approved)

Adjudication runs independent single-pair requests, ten at a time, with `adjudicate-v3`; this replaces the earlier "no concurrency yet" rule. The sequential strategy remains as a fallback. A live comparison on 40 pairs (`reports/benchmarks/adjudication-strategies/runs/strategies-1/`, git-ignored) found ten at once as accurate as five and twice as fast, while batches of 10 lost recall, omitted verdicts and returned placeholder explanations. Batching stays only as an experiment. A live analysis found mid-run after a restart becomes `interrupted`, and only an explicit resume sends more paid requests.

## Implementation note: hybrid retrieval as built (October 30)

Implements "Candidate retrieval" with mock models; no paid call has read real testimony yet. Analyses choose their pool with `analyses.retrieval` (migration 0014, additive): `pair` stays the default until hybrid passes evaluation, and `hybrid` is opt-in per analysis.

- **Cards.** `cards-v2` (`cards-v1` was the pilot), about 10 pages with one page of overlap, five chunks at a time. A chunk cut off at `max_tokens` is split in two and sent again, and three failed calls in a row stop the run. Omitted and failed parts are retried by a re-run; carded and `no_assertion` parts never are.
- **Thin chunks.** A call can end normally having skipped most of its chunk, so a readable response that addresses under half its parts is reported in `thinChunks`, with its call. Its parts stay `omitted`, retried by a re-run.
- **Call ceiling.** `maxChunks` (`--max-chunks`) caps a run's calls: a cut-off chunk is recorded as failed instead of being split.
- **Topic map.** A failed map stores nothing. A large witness is read in parts with the map so far, the same mechanism as a new session, rather than per-session maps merged afterwards.
- **Selection.** Paths take turns in proportion to their shares, and adjudication runs in that order, so a budget stop can't let Path A spend it all before Path B contributes. Nothing is reserved: a path that runs out simply stops taking turns.

**Deviations from the specification:**
- Path A also links cards with no shared topic when they share a grounded entity and a predicate other than `other`, so a topic label is never the only way in and unassigned cards can be found. Path A works with no map at all.
- A signal counts fully only between comparable cards: overlapping objects, or event lines sharing at least half their words. Same-event overlap also breaks ties within a tier. The specification's ranking doesn't check that two cards describe one event.
- A card label never excludes testimony (approved October 30). Pairs whose cards are hypothetical, reported, unanswered or assert nothing rank last in Path A and are `deferred` with that reason, still eligible. `excluded` is unused by the hybrid pool.
- `noAssertion` is an extraction result, not a finding. Code screens it on answer size, factual language, and whether a short answer responds to a question that still states a fact once housekeeping words are removed, leaning toward doubt. A doubted one is `suspected_omission`, with its signals and the response kept, and is sent again only by a targeted run, with the two exchanges before it as context. A repeated `noAssertion` stays suspected. `no_assertion` means nothing raised doubt. Path B reads none of this.
- The hybrid per-exchange cap is 5 (3 in the pair pool, approved October 30 after the first map left Path A at 143 of 180 slots). It applies while capacity is scarce; spare capacity then goes to capped candidates in rank order, instead of sitting unused.
- A budget stop leaves candidates `selected` (awaiting assessment), not `deferred`, so a resume continues them without a state change.
- Capacity is `analyses.max_candidates`, with the dollar ceiling enforced per request as before, not derived from `ceilingUsd`.
- Live hybrid analyses are also interrupted, not resumed, when a redelivery finds them `retrieving`, because that stage now pays for cards.
- `retrieve/audit.ts` (the Path B audit sample) and `CandidateSource` aren't built. Real-label recall is not implemented: `data/eval/ellison-labels.json` has no pairs yet.

## Implementation note: OCR (October 31, approved)

Scanned depositions were out of scope; real users have them, so a file with no text layer is now read by Tesseract and Poppler, locally, with no testimony leaving the server. It is a route beside the text-layer parser, which is unchanged: `ingest/ocr.ts` produces the same page extraction, and validation and exchange building follow.

- **Page:line comes from position.** A grid is fitted to each page's gutter digits, relative to where that page's gutter actually sits, because scans shift. A digit disagreeing with its position fails validation. A faint digit falls back on position.
- **Nothing is merged into testimony.** Handwriting between lines belongs to no line and is listed in `validation.ocr.annotations`. Specks are counted. A first page with no printed number is a cover sheet, listed and given no lines.
- **Page numbers.** One unreadable or misread number is inferred only when both neighbours leave exactly one value, and is listed in `inferredPages`. Otherwise the page fails.
- **Confidence.** Each OCR line stores `ocr_confidence` (migration 0016), and findings return it. A page averaging below 80 fails validation. **OCR text can differ from the scan, so unlike a text layer it isn't exact evidence: the UI must say a line was read by OCR.**
- **Scope.** One layout, `scanned-25-v1`: 25 lines, a left gutter, the page number at the right, bottom or top. A text layer that fits no layout, such as a scanner's own OCR, is replaced by this OCR when that does better. Otherwise, files mixing text and scanned pages aren't OCR'd. A lone "|" is read as "I" and counted. Without the tools installed, a deposition stays `needs_ocr` with that reason.

## Implementation note: one pipeline (October 31, approved)

Hybrid is now the only pipeline, and v1 is gone, on the developer's instruction. Removed: the claims pipeline (`claims/tag.ts`, `retrieve/pathA.ts`, `retrieve/merge.ts`, the `pair` branch), the batch format and strategies D, E, F and P, the v1 analyzer and its Quick compare screen, and the scripts built on them. Sections above that describe claims, RRF merging, batching or v1 are history.

- New analyses are hybrid, whatever a client sends. `analyses.retrieval` defaults to `hybrid` (migration 0017). Past `pair` analyses stay readable, and no table, column or row was dropped.
- Adjudication's disagreement check read claims, so it now receives none, as new uploads always did. On Ellison, where claims were stored, a re-run can score differently from earlier runs.
- A live analysis without paid access stops before retrieval rather than after.
- The direct full-transcript call stays in `experiments/multimodel-contradictions/`, outside the product.

## Implementation note: direct discovery as the default (November 1, approved)

**This note supersedes the earlier sections wherever they describe the default analysis path.** A live analysis now reads both sessions whole with Claude Fable 5.1. Hybrid retrieval stays as a non-default option (`method: "hybrid"`), and demo mode still replays stored hybrid verdicts. Stored hybrid and pair analyses stay readable. Hybrid is kept, but no longer tuned.

**Why.** On the one independently documented inconsistency we have (Hutchinson, June 6:06 "Presidential limo" against September 33:09 "Presidential SUV"), hybrid never assessed the pairs, and Sonnet rejected them when shown as pairs. Fable reported the pair in both runs that finished, classed as needs context. One case can't establish general recall.

**Pipeline.** Ingestion and speaker attribution, then one Batch API request holding both complete sessions, then deterministic verification, conservative deduplication, lanes, and the existing workbench. Fable proposes candidate inconsistencies. It does not establish that a witness contradicted themselves.

**Full context.** Every stored line is sent, whatever its OCR confidence. Input is bounded from characters, which can't undercount tokens, and if the bound plus the output budget exceeds the context limit the analysis fails with a clear error. Nothing is truncated, chunked or partially analysed.

**Refusal fallback and job state.** `discovery_runs` holds one row per paid attempt: at most one primary and one fallback. Each row and its budget reservation are written before the provider is called, the batch ID right after, and the result is stored in one transaction. Waiting holds no job open: the worker polls every 30 seconds through the existing requeue. A restarted worker polls the batch it already has. If a worker died between writing the row and recording the batch ID, nobody can know whether the batch exists, so the run becomes `submission_unknown` and nothing more is sent. A failed batch check keeps polling through about five minutes of provider trouble. After that the run closes as `provider_failed` and its reservation counts in full, because the batch may have been billed.

A direct analysis resumes only after a budget or credentials stop, or a cancel before anything was sent. Every other stop is final, because no attempt repeats, and the answer is a new analysis.

Only an explicit refusal leads to the fallback (Opus 5.5), once, and only if the budget covers its worst case. A valid empty answer, a needs-context finding, invalid output, a cut-off answer, a provider failure or too little context capacity never does. Refused attempts are recorded with their cost, because they can be billed. Results carry the model that produced them, and a fallback is shown as one.

**Verification (`verify/direct.ts`, pure).** Every proposed finding is checked for source identity, quotation accuracy, speaker and OCR provenance. Model interpretation is kept apart from source facts: code doesn't say two statements conflict. The frozen hybrid rubric doesn't apply here, because its inputs are the Sonnet verdict's fields. Direct findings have evidence strength instead (below). An attorney's words count only if the witness plainly adopted or denied them. An exact match against OCR text shows the quotation is in our reading, not that the page was read correctly. Failed findings are kept: in the Unverified lane, or in the run's audit if their citations resolve to nothing, and those are listed on the analysis.

**Lanes (code's decision).** Potential contradiction: both sides verified witness testimony, no doubt flagged. Needs context: the model said so, comparability is uncertain, a quotation is approximate, speaker unknown, no recollection, or a cited line below 85% OCR confidence. Compatible or dismissed. Unverified: failed references, unsupported quotations or attorney-only words. Direct versus inferential stays as metadata. The headline follows the lane, so a held-back finding never reads as a contradiction.

**Deduplication.** Deterministic and conservative: two findings merge only when both passages overlap by at least half of the shorter one, on the same pair of sessions. A–B and B–A are the same pair. The most cautious copy is shown, and the originals stay on the finding. An evidence key lets a review decision carry over to the same passages in a later analysis. Review decisions remain browser-only, as before.

**Speaker attribution.** Hearing-style labels (`Ms. Cheney.`) are read as turns, using the witness's surname, which ingestion now receives. Near-miss surnames, garbled labels, stray marks where a speaker was redacted, and labels with no known witness stay `unknown`, and unknown speech is never treated as testimony. A bar joined to a word reads as "I" in matching only. `lines.ocr_text` keeps what OCR read when a correction changed the stored line. `PARSER_REVISION` is 2. Stored depositions keep their old parse until re-ingested, and re-ingesting replaces their rows, which deletes analyses on them, so it is a deliberate step.

**Cost and latency (measured once each on Hutchinson, 5,175 lines).** Fable batch: $1.65 and 6 min 52 s. Fable standard: $3.09 and 7 min 14 s. One batch was refused after 3 min 6 s and cost $1.00. Most batches finish within an hour; the limit is 24 hours. The default budget for a direct analysis is $6.

**Data retention and confidentiality.** Fable requires 30-day retention, and zero data retention needs Anthropic's express authorization. Public and synthetic testimony passing through a hosted model establishes no permission to send confidential client records. Provider retention and contractual requirements must be reviewed before client use.

**Evidence strength (`evidence-strength-v1`, `score/evidenceStrength.ts`, pure).** A five-point checklist, 20 points each, from existing fields: no extra model call, no prompt change, and any stored finding can be rescored with `scripts/rescore-direct.ts`.

| Check | Decided by | Points |
|---|---|---|
| Quotations match the transcript | Code | 20 both exact, 10 if any is approximate |
| The statements are the witness's | Code | 20 (anything less isn't scored) |
| Clear assertions: no hedge, no lack of recollection, not secondhand | Code | 10 per side |
| Same subject (`comparable: yes`) | Model | 20 or 0 |
| Conflict holds without missing context | Model | Direct 20, inferential 10, otherwise 0 |

A finding with an invalid citation or an unknown, mixed or attorney-only speaker has no score. A compatible finding has none either, because solid evidence there isn't support for a conflict. It measures how well the cited testimony supports review, not the chance that the witness contradicted themselves. It can't separate a flat negation from conflicting values, and it can't detect a false positive: the Webb home-versus-parking-lot finding scores 80. A richer rubric would need structured fields from the model, which means a new prompt version. Hybrid scores keep rubric v1.

**Priority (`priorityOf`).** The score decides neither lane nor priority, and only orders findings within a priority. Precedence: failed verification (Unverified), missing context or unresolved attribution (Needs context), compatible (Low), then conflicts. High needs a direct classification, `comparable: yes`, and at least one side a plain assertion: one hedge doesn't undo a conflict, but two leave it softer. Other direct conflicts and all inferential conflicts are Medium. An alternative explanation alone never lowers a finding, because the prompt requires one on every finding. Code can't tell a true inference from a false one, so Medium holds both, and a semantic false positive from discovery stays a Potential contradiction for a person to dismiss.

**Evaluation.** `scripts/direct-benchmark.ts` scores a finished analysis against the Webb and Whitfield labels by source lines on both sides, and counts needs-context separately from confirmed detections. These fixtures shaped development, so this is a development-tuned synthetic evaluation, not a held-out benchmark, and it says nothing about real depositions. Earlier Sonnet results are historical data from different conditions, not a controlled comparison.

## Implementation note: cross-witness analysis (November 3, approved)

**Scope.** A cross-witness analysis compares one session of one witness with one session of another witness in the same case, and reports where their accounts may conflict. The user selects the two sessions exactly as for a same-witness check; sessions of two different witnesses make it cross-witness. It runs by direct discovery only; hybrid retrieval and example (demo) mode stay same-witness. Same-witness analysis is unchanged and stays on Fable.

**Model.** Claude Opus 5.5 reads both sessions (`discover-cross-v2`, `xhigh`, 64,000 output tokens, one Batch API request). Fable 5.1 answers only after a confirmed refusal, mirroring same-witness discovery. The choice rests on the November 3 evaluations: on the independent synthetic suite (`data/eval/independent-cross-v1`, 19 strict conflicts, 4 review-worthy pairs, 25 controls) Opus matched Fable on every label at $0.50 against $1.77; on Simpson and Resnick it found the same three review-worthy pairs at $1.02 against $2.63, and reported one review-worthy pair (C01) as a contradiction where Fable held it at needs context. Both test sets are small, one is AI-written, and one real case can't establish recall. Opus missed the Hutchinson limo/SUV pair in a same-witness run, which is why same-witness stays on Fable.

**Storage.** `analyses.kind` is `same_witness` or `cross_witness`. A cross-witness analysis keeps witness A's session in `deposition_a` and `witness_id` and witness B's in `deposition_b` and `witness_b_id`; witness A's is the earlier session, as in same-witness checks. Findings use the same candidate, verdict and finding rows as same-witness direct findings, with `checks.cross` recording both witnesses, the session labels and each witness's knowledge basis as the model read it. Witness A's side is always side A, whichever way the model cited them.

**Guards.** Both sessions must belong to the case and be dated, and both must fit the context window with the output budget; otherwise nothing is sent. Deleting either session deletes the analysis. The prompt and the benchmarks accept several sessions a side (`A1`, `A2`, ...); the product sends one each.

**Verification and lanes (`verify/cross.ts`, pure).** As direct discovery, plus: two passages of one witness are never a conflict between witnesses (Unverified); a lack of recollection never conflicts with another witness's memory (Compatible); references that aren't official page:line hold a finding at needs context. Quotations stitched from ordered fragments are verified piece by piece and never shown as one continuous quotation. Evidence strength uses `evidence-strength-cross-v1`, whose High priority needs both accounts first-hand.

**Coverage.** Every direct analysis reports the testimony it never received (blank or unread pages, missing printed pages), computed from stored rows, and the model's own completion status and limitations, labelled as the model's.

**Default budget.** $6. Opus's worst case on both Simpson and both Resnick sessions together was $2.43, so one session of each fits with room for the Fable fallback; a check that can't fit stops at the budget and can be resumed with more.


## Implementation note: Stage 1 evidence foundation (November 3, on the `multi-analysis` branch)

**Purpose.** The case-wide pipeline that replaces pairwise comparisons needs every Q/A exchange of every witness stored, indexed and traceable before any event extraction, retrieval or adjudication is built on it. Stage 1 builds that foundation and nothing above it: no events, embeddings, candidate ranking, model calls or UI.

**Hierarchy.** Case → witness → session (`deposition_sessions`) → document (a `depositions` row, one uploaded file, with `session_part`) → source lines → exchanges. A session is one sitting of one witness and can span several files; a file joins a session only when the caller names it (`saveDeposition({ session })`, `scripts/ingest.ts --session-of`), never because the witness or date match. A database trigger gives a file stored without a session its own, so every existing insert path keeps one file per session, and removes a session left empty. Existing depositions were each given a session with the same ID by migration 0028.

**Exchanges as evidence.** The existing exchanges (Q/A across page breaks, long answers in overlapping parts, exact line membership, attorney, witness, colloquy and unknown speakers kept apart) are the evidence unit. Each now carries an `evidence_key` (from the file's SHA-256 and its first and last stored positions, so it survives re-ingestion and is the same in a fresh database), a `text_hash` of its stored lines, and a `speaker_status` from the reader's line roles alone: verified (every answer line the witness's, nothing unattributed), uncertain (some text with no identified speaker), invalid (no answer, or answer lines attributed to someone else). A status is only ever recomputed from the lines, so nothing promotes it. Ingestion sets the fields; `scripts/evidence.ts index` fills them for exchanges stored earlier, with the same functions. Reading an exchange recomputes both and reports any drift.

**References.** A stored position is cited in its transcript's own scheme (`evidence/references.ts`): printed page:line (`6:04`), a text file's line (`line 12`), a counted PDF row (`page 3, row 7`), an archive statement (`statement 782`, with its part when the count restarts), or unrecognized. Only a printed page:line is marked citable; nothing is converted into page:line. A source line's stable identity is its file and position.

**Index.** The existing Postgres full-text index over each exchange's question and answer text (`exchanges.tsv`), filtered by case, witness, session and document, one result per answer (the best of its overlapping parts). Search uses the original words only. Results and direct retrieval return the exchange's stored source lines verbatim, its references, and its context: the lines before and after, and the previous and next exchange in the session, across its files. Coverage reports, per file, what is and isn't indexed: files not read, blank or unread pages, missing printed pages, witness lines in no exchange, exchanges not yet indexed, and a session whose files' dates differ.

**Fixtures.** `data/eval/evidence-fixtures-v1.json` names real passages (Hutchinson limo/SUV; Simpson-Resnick dog, alley and three controls) by file hash and position. The files stay local and git-ignored; Hutchinson's are its stored lines and exchanges, exported once, since its scans need OCR.

**Parser fix.** An archive export's bare statement number (an empty statement) was appended to the statement before it, changing the stored text of 22 Simpson statements. It is now left out and counted; `PARSER_REVISION` is 8.

### Stage 1 stabilization (November 3)

**Speaker segments (parser revision 9).** An archive statement can run two turns together ("Q: … drove up in? A.Yes, I do."). The statement stays one source line with its text untouched; `line_segments` (migration 0029, additive) holds each speaker's part as a character range of that text, under the line's one reference, for lines with more than one speaker only. Segments are recognized in the archive format only, after a sentence ends, never inside quotes or parentheses (read-backs) or inside the statement's own leading label, and never at initials ("A.C."). Each segment's speaker comes from the reader's own label rules. In the evidence layer an exchange's answer is what the witness said (answer lines and witness segments) and its question what the attorneys said; an attorney's segment is never part of an answer. A label one or two letters from the witness's name stays unknown. Exchange boundaries stay line-level: a question that opens mid-statement stays in the exchange of the statement it is in, and is labelled as the attorney's.

**Named speakers and notes (revision 9).** An archive names every speaker in full ("ROBERT BAKER:"); such a label, when it is neither the witness's name nor close to it, is a named speaker other than the witness, no longer unknown. A note closed on its own line ("[2:05 p.m.]", "(Recess.)") is a note at any indent, including a centred one.

**Attribution audit.** `scripts/evidence.ts attribution` counts verified, uncertain and invalid Q/A exchanges and gives each non-verified one its likely cause: no testimony (attorney or counsel only), front or back matter, a redacted speaker label, a garbled marker, an unrecognized label, a note left unknown, an answer attributed to someone else. Only deterministic causes were fixed; redactions and garbled OCR stay uncertain.

**Parser revisions.** `scripts/evidence.ts parser-audit` reads stored rows only and reports, per document, the artifacts later revisions fixed (an archive's stray statement number, a note read as speech, a named speaker left unknown, an unsegmented archive statement) and what re-reading would affect. `reprocess` re-reads a stored file in place (same document, case, witness and session), as a dry run unless `--execute`, refuses to remove findings unless `--accept-impact`, and reports the source IDs whose text, speaker or presence changed and the exchange IDs removed and added. `correct` is the non-destructive path: when every line keeps its position and text, it updates speaker roles, segments and each exchange's derived fields in place, so line IDs and the IDs of exchanges whose lines don't change are kept with everything attached to them. An exchange whose lines change is replaced only when nothing refers to it; otherwise nothing is changed and the report maps it to the corrected exchanges sharing its lines and lists the findings that would need review (a versioned migration, not yet built). Executing writes a backup of every overwritten row first and checks, before committing, that no candidate, verdict, finding, review, card or claim was lost.

**Excluded copies.** `depositions.excluded_reason` marks a stored copy kept only for its history: `legacy_parse` (read by a parser too old to correct without losing findings) `duplicate` (the same file stored again in the case; `duplicate_of` names the active copy) or `misfiled` (another witness's or case's testimony stored under this one). An excluded copy keeps every line, exchange, analysis, finding and review, and its analyses still display, but it is never offered to search, evidence lookup, coverage totals, Path B, the topic map or a new analysis (the API answers 409 `deposition_excluded`). Coverage lists excluded copies with their reason and reports any file still active twice in a case, so one testimony is never counted as two depositions. Deleting an active copy makes its earliest duplicate the active one.

**Several turns in one statement (revision 10).** An archive statement can hold an answer and the next question ("A: Yes. Q. Where?"). A new question or examiner label inside it starts a new exchange by the same rule as between lines; the statement stays one source line with its text and reference, and belongs to both exchanges. `exchange_lines.segment_from`/`segment_to` record which of its segments belong to each, and the speaker status, question and answer of an exchange use only those.

**Real-data evaluation.** `scripts/evidence.ts eval-real` runs the fixture checks in the test database and fails when a fixture file is missing or a check fails; the Vitest file runs the same checks and skips, saying so, without the files.

**Long answers.** Each part reports the lines it shares with its neighbours, and `answerGroup()` returns a split answer's lines once each, in order, with every part's ID.

## Implementation note: Stage 2 fact and event extraction (November 3, on the `multi-analysis` branch)

Module `server/src/claims/facts/` (in `claims/`, one of the two modules allowed to call a model), migration 0032 (`fact_units`, `facts`, and `fact_extraction` in `llm_stage`), and `scripts/facts.ts`. Independent of Stage 3 retrieval and Stage 4 adjudication: Stage 3 reads only `verifiedFacts()`.

**Units.** One logical answer group (every part of an exchange group, with the overlap of a long answer read once, as `answerGroup()` does), rebuilt from stored Stage 1 rows. Citable spans are the source lines, except that a line holding several speakers' turns gives one span per speaker segment of that exchange, so an attorney's words on a witness's line are never read as testimony. The end of the previous group is shown as context and can't be cited. A group over 12,000 characters is cut into windows of whole spans that overlap by three and repeat the question; a single statement too long for a request makes the unit `incomplete`, never truncated. A group with no witness or unidentified speech is recorded as `no_testimony` and not sent.

**Facts.** One record per independently testable assertion: subject, predicate, object (the asserted value), a factual question and a snake_case factual dimension worded without the answer, polarity, epistemic status (asserted, qualified, does_not_recall, does_not_know, reported_by_other with its speaker, hypothetical, unclear), the witness's hedges, time and location context, and a provisional event (description, type, participants, date, location). Extraction never assigns an event identity or relates two facts.

**Verification (code, deterministic).** The unit and spans must exist in the request; the evidence phrase must be in the cited spans' own words (verified, approximate, or rejected as unsupported). Attribution: the witness's words are a `witness_statement`; a phrase in an attorney's question counts only as `question_adopted`, cited with the witness's short answer, and its polarity must agree with what the answer says; anything else from a question is an `attorney_assertion` and rejected; counsel and notes are never facts; unidentified speakers and Stage 1's uncertain exchanges make the fact `uncertain`, its invalid ones reject it. Code also rejects a non-recollection given a polarity, reported speech without its speaker, and a dimension containing the asserted value (words of the object the question doesn't use); a generic dimension, an ungrounded hedge or participant is a warning. Only `indexed` facts are in the verified index; rejected ones are kept with their reason. A verified quotation says nothing about whether the reading is right.

**Persistence.** `fact_units` has one row per unit and extractor version (prompt, schema and model) from the start, so coverage counts pending, extracted, empty, no_testimony, omitted, failed and incomplete units. Fact keys are stable for the same reading of the same answer group, so retries and overlapping windows can't store a fact twice. A unit whose source spans change (text, speaker or role) has its facts marked `stale`, kept out of the index, until it is extracted again. Excluded document copies are never planned, extracted or returned. Every call is recorded with `recordCall` (stage `fact_extraction`, Haiku) under an optional budget; the CLI's paid `run` needs `ALLOW_PAID_CALLS=true`, a budget and `--execute`.

**Evaluation.** `data/eval/facts-expected-v1.json` holds hand-authored records (references and word ranges only) for the Hutchinson limo/SUV, the Simpson-Resnick dog and alley passages and compatible controls; `scripts/facts.ts eval-real` runs them through the real pipeline with a stand-in model. It shows what the schema expresses and what verification accepts; it measures no model and reports no recall. `evaluateRecall()` is ready for labelled facts once real extractions exist.

**Revision after the first real-model pilot (facts-v3, fact-schema-v2).** The first Haiku pilot (facts-v2) matched 2 of 6 labelled assertions, no labelled pair shared a dimension, and four facts were lost to unit IDs the model invented. Changes:
- *Positions, not IDs.* The output holds one group per input unit, numbered as the request numbers them; spans and context lines are cited by number. Code assigns each group to the unit at its position; a missing group leaves the unit `omitted`, a repeated one fails it, an out-of-range one is reported; a fact never moves to another unit.
- *Representation.* Each fact has a kind (action, attribute, memory_or_knowledge), subject and entities, predicate, attribute (the property, without its value), value with the exact words stating it, an answer-independent question, polarity, time and location scope, epistemic status, hedges, a correction flag and a provisional event with its anchors. The model no longer writes a dimension: code derives an attribute key from the attribute (or predicate) with dates removed, a lookup hint only. Stage 3 should compare question, attribute, value and entities (`compatibility()`), not exact keys.
- *Verification.* The assertion's phrase must be in the unit's own cited spans; an attribute's value phrase in its cited spans or cited context lines; the value's distinguishing words may not appear in the attribute or the question. A memory or knowledge answer is its own kind with polarity unknown, never a denial, and an empty group for such an answer, or for a substantive one, is a `suspected_omission`, not `empty`. A fact is `source_supported` only when its value is its cited words and nothing needs a reader; otherwise `needs_semantic_review` with reasons (a normalized value, a yes/no question naming a value, an adopted answer that isn't a plain yes or no, a reported speaker not named in the testimony, approximate matches). Code never marks a reading semantically verified.
- Pilot files: `data/eval/facts-pilot-v1.json` (the baseline, facts-v2, outputs kept in `data/raw/pilot/`) and `facts-pilot-v2.json` (the same windows plus held-out ones, for facts-v3). Each pilot reads only its own extractor version.

## Implementation note: discovery reliability pivot (November 3, on the `multi-analysis` branch, not yet approved as architecture)

**Stage 2 v4 (facts-v4, fact-schema-v3).** After pilot 2: each request's schema has one required key per unit (`u1`…`uN`, at most 8 units a request; one for critical evaluation runs), and each group copies its unit's opening words, which code compares before using any fact, so a group written for one unit can't be stored on another. A bare yes/no answer must cite its question; a value appearing in the question is flagged for review, not rejected (question words never count); reporting verbs read as the witness's own assertion, and questions in the second person, are flagged. No paid run has used v4.

**Independent retrieval probe** (`server/src/retrieve/independent.ts`, pure; `server/src/eval/retrievalProbe.ts`; `scripts/retrieval-probe.ts`). Items are logical answer groups built from Stage 1 rows; four paths run without Stage 2 facts: Postgres full text (each group's rarest lexemes), LSA (latent semantic analysis, a dependency-free stand-in for neural embeddings), question-centered TF-IDF (question plus preceding context) and anchors (names the corpus capitalizes mid-sentence, dates, weekdays, years), fused by reciprocal rank per query. Measured on all six real fixture documents together (5,620 answer groups, five sessions): ranked as one case-wide list no path brings a review-worthy pair into the top 1,000; per query, fusing the paths ranks the three review-worthy counterparts 1st, 3rd and 4th. Stage 2 facts added nothing measurable (7 candidate pairs, none known; they exist only in the pilot windows). Experimental: not production retrieval.

**Retrieval development round (November 3, three agents, integrated by the lead).** Frozen benchmark format and freeze script (`server/src/retrieve/frozen.ts`, `scripts/retrieval-freeze.ts`, baseline tag `retrieval-baseline-v1`); independent evaluator (`server/src/eval/retrievalEval.ts`, `scripts/retrieval-eval.ts`), held-out Simpson-Resnick pairs and a second corpus from the blind-reviewed `independent-cross-v1` set (20 transcripts in one corpus); local MiniLM embeddings (`@huggingface/transformers` 4.3.1, Xenova/all-MiniLM-L6-v2 at a pinned revision, remote loading disabled); candidate triage (`server/src/retrieve/triage.ts`). Measured on both corpora: MiniLM over question, answer and context with speaker labels stripped helps as a fifth fused path (corpus 2: 20 of 23 targets in the top-5 pool against 18) and loses targets when it replaces LSA, so LSA stays. No label-independent triage reached 2,500 pairs with every target kept: the rare-word gate and the ratio-test budget lost targets on the independent corpus. The adopted triage default (no gate, two partner passages per item, no budget) keeps every target the pools held while cutting corpus 1's pool by 41% and corpus 2's by 25%. Ingestion limits found: four colloquy-format transcripts are each read as one exchange, and cover, appearance and errata pages enter the corpus as items.

**Discovery, parsing and triage round (November 3, six agents, integrated by the lead).** Parser r11 reads colloquy-format transcripts (no Q./A. markers): the examining attorney (the latest BY heading, or the titled attorney before most witness turns) asks the questions; independently validated (byte-identical source reconstruction, no promoted attribution, no stored dev document affected). Evidence eligibility (`server/src/evidence/eligibility.ts`) keeps cover, signature, colloquy and objection groups out of ordinary retrieval, listed with reasons, errata kept apart. Corrected baseline (r11 + eligibility + MiniLM, default triage): corpus 1 holds 4 of 4 targets in 14,476 pairs; corpus 2 21 of 23 (within one case 1,199 pairs). The numeric/negation path `F_factual` (fused, plus each item's top factual partner reserved) adds corpus 2's two development cases (23 of 23) but finds no corpus-1 pair and ranks half the compatible controls high: experimental. Local reranking (relevance and NLI cross-encoders) does not improve the trade-off on both corpora and is kept only as an experiment; it never excludes. Issue packets (`server/src/retrieve/grouping.ts`, at most 8 passages and 6,000 projected tokens) cut projected calls about 4x (corpus 1, 3,320 vs 13,557 within one case) with every pool pair covered; their adjudication quality is untested.

## Implementation note: packet versus pairwise adjudication (Milestone 2, November 3, on the `multi-analysis` branch, evaluation only)

The packet contract (`server/src/adjudicate/packetSchema.ts`, `packetPrompt.ts`), loader (`packetLoad.ts`), client (`packetModel.ts`) and verifier (`server/src/verify/packet.ts`) evaluate grouping evidence pairs into issue packets against one pair per request; normal analyses don't use them. Results, costs and limits are in `docs/milestone-2-results.md`: the same targets were found in both arms at 32% less cost, but only 1 of 4 real review-worthy targets, so real-world detection is not validated.

## Implementation note: safe evidence correction (November 5, on `feature/safe-evidence-correction`, needs approval)

Not merged. It changes what the model sees and adds migration 0039, so it needs approval before it is merged or
run on working data. Operator procedure: `docs/evidence-correction.md`.

### Parser revision 12 (segments-v2)

**The rule.** Archive exports sometimes run two turns into one numbered statement. Revision 9 already split
labelled turns ("Q:", "A.", "MR. BAKER:"). Revision 12 adds one rule in `server/src/ingest/segments.ts`: a bare
"Q" starts the examiner's turn when it:
- follows a sentence's end;
- sits outside quotes and parentheses;
- is followed by a capitalized word.

Example: "A: Cocaine, no. Q You've never…".

**What isn't split.** A bare "A" never splits, because it is also an English word ("Yes. A man came in"). Those
statements stay one turn.

**Measured effect.** Checked statement by statement against revision 11:
- exactly 11 statements change, in Simpson day 2, Simpson day 9 and Resnick day 9
  (`tests/fixtures/segments-v2-confirmed.json`);
- every other archive transcript, and every PDF, reads byte-identically apart from the version.

**What doesn't change.** Text is never edited. A segment is a character range of the stored statement, so its
page:line, offsets and order are the source's. Exchanges are built from segments, so the question is now the
next exchange's question and its answer is attached to it.

### Packet rendering spans-v1 (model input)

**What changed.** A statement shared by two exchanges is shown to each exchange as only the turns it owns.
- `exchange_lines.segment_from`/`segment_to` say which turns an exchange owns.
- The shown text is a slice of the stored text, marked on its page:line ("1:360 (part 2 of 2)").
- A lawyer's question is therefore never shown inside the witness's answer.
- Context lines are still whole stored lines.

**Recording.** The prompts' wording is unchanged. Each verdict's packet record says `render: "spans-v1"` and the
evidence epochs it was read at.

**Limit: PDFs.** They hold no turn offsets: a PDF line is one physical line, so a statement with two turns only
exists in archive text.

### Citations, attribution and the contradiction assessment

Three things are kept apart, as before:
1. **Source citations.** The model cites lines it was shown. Code checks every quotation against the stored
   line's text (`verify/`), never against model output.
2. **Attribution.** Who said the cited words comes from the stored speaker of the line or segment, and from the
   exchange's member roles (question, answer, context). Code computes the attribution levels.
3. **The contradiction assessment.** The model's classification of the pair, scored by the rubric only on
   verified citations.

**What a parser correction changes:** attribution and exchange boundaries, never text. So:
- A citation by line ID stays a valid quotation after a correction.
- The attribution it was scored with, and the assessment the model made from a packet that showed the old
  boundaries, may no longer hold.

That is why a correction quarantines the verdicts and findings built on changed evidence rather than re-pointing
them: re-pointing would silently keep an assessment made from a different reading of the testimony.

### Evidence versions (`depositions.evidence_epoch`)

**The counter.** `evidence_epoch` counts the committed corrections and rollbacks of a document's evidence.

**How jobs use it.** A job that derives results records the epochs of the depositions it reads, before it first
reads them:
- an analysis or a case run keeps them in `source_epochs` across deliveries, resumes and polls;
- a fact or card extraction keeps them for its run;
- a packet records them when it is loaded.

Every result is written through a connection that declares them (`evidence.read_epochs`, `server/src/evidence/
epoch.ts`).

**How the database checks them.** Migration 0039's guard checks the declaration in the same statement as the
write, under the same key-share lock a correction must wait for. A write is refused (SQLSTATE `VE002`, "stale
evidence") when:
- a declared epoch is no longer current;
- or the job writes for a deposition it didn't read.

This holds whenever the write arrives: during the hold, after the hold is released, or days later from a polled
batch.

**What the job does then.** It stops:
- an analysis or case run is marked failed with the reason, and stores nothing more;
- an extraction stops, and keeps nothing from the reading.

**A person's review is checked too.**
- **Capture:** the finding detail carries the epochs of its two depositions, read before anything else.
- **Submit:** the review must send them back (HTTP 400 without them, or with another finding's).
- **Save:** it is saved in a transaction declaring them, and the quarantine is re-checked inside it.
- **If a correction committed after the reviewer opened the finding,** the save is refused (HTTP 409). The page
  reloads the finding as it now stands, and the review can be made again.

**What doesn't declare:**
- The correction itself is the holder.
- The demo-case seed creates its depositions and everything derived from them in one transaction, so no
  correction can come between.
- The synthetic-fixture store declares the epochs of the sessions it reads.

### The correction hold

**Holding.** Executing a correction first holds the document (`depositions.evidence_hold`), in its own
transaction. It is refused while any analysis or case run of the case is unfinished, or the document isn't ready.

**While held**, the database refuses every write to the document's lines, segments, exchanges and derived rows,
and to the deposition row itself (no delete, no re-read), except the holder's (SQLSTATE `VE001`, HTTP 409 in the
API). Meanwhile:
- analysis and case-run jobs wait instead of reading;
- ingestion retries;
- fact extraction refuses.

**The correction transaction** takes the document row `FOR UPDATE`. So it waits for writers already running, and
writers arriving during it wait. It refuses if work older than the hold is still unfinished.

**Releasing.** The correction commits with the hold still set, and only then releases it.
- **A job's write that waited** on the correction's lock is refused either way: by the hold if it re-checks
  before the release (`VE001`), and by its stale epoch after (`VE002`).
- **A write that declares no epochs** is guarded only by the hold while it lasts. If it waited on the lock, it can
  land just after the release. Jobs, extractions, reviews and the fixture store all declare; what doesn't is the
  correction itself and the single-transaction demo seed.
- **A crash between commit and release** leaves the hold for an explicit `release`, which checks the document is
  exactly as the ledger says it should be.

### Derived-data invalidation (`server/src/evidence/correction.ts`)

**How it runs.** The correction wraps `correctInPlace` (which keeps line and exchange IDs) in one transaction:
- **Dry run:** the whole correction, rolled back. Executing needs its plan hash and the expected changed lines,
  and refuses anything else.
- **Integrity before and after:** fact-unit exchange IDs and group numbers, fact exchanges, screening entries,
  candidate group numbers. Any broken reference, before or after, means nothing is written.

**What happens to each kind of derived row:**
- **Facts** on a replaced exchange are detached and marked `stale`, never deleted by the foreign key.
- **Fact units** follow the corrected exchanges. `syncUnits` resets units whose source hash changed (their facts
  become stale), removes units that no longer exist, and now also updates the group number, window and exchange
  IDs of units whose source is unchanged. Their key and source hash prove that.
- **Screening entries** that name a replaced exchange block the correction: they record model calls and are
  never rewritten.
- **Candidates, verdicts and findings** on an affected exchange are quarantined. An exchange is affected when it
  is replaced, added, changed, or holds a statement whose speaker or exchange changed. A verdict is also
  quarantined when its packet showed such a statement as context.
- **Replay** never copies a quarantined verdict.

**Backup and rollback.** A backup is written before commit. `rollbackCorrection` restores it and must end with
the document hash recorded before the correction, or it changes nothing.

### Quarantine and review history

**Where it lives.** `evidence_quarantine` rows point at findings, verdicts and candidates. They are active while
their migration in `evidence_migrations` is `applied`.

**What is never changed.** A quarantined finding's row, and a person's review of it (state, note, time), are kept
as they were. The quarantine row keeps the review as it was, with the parser it was made on.

**How a quarantined finding is presented:**
- **API:** standing `quarantined`, group "Needs revalidation".
- **Counts:** never among current findings, decisions, review queues, the report or replay.
- **Review:** an ordinary review is refused (HTTP 409).
- **UI:** a notice says the transcript was re-read, gives the reason, and gives the earlier review in the past
  tense ("Previously kept on …"), with its note and its testimony still shown.
- **Recovery:** after a 409 the page reloads the finding and the list itself.

**How a quarantine ends:**
- **Revalidation** is a new analysis of the corrected transcript, and a quarantined finding is never promoted
  back.
- **Rolling back the correction** ends its quarantine.

**Other policies**, applied with `scripts/evidence.ts quarantine`:
- superseded parses (`legacy_parse`), sources whose text a re-read changes, and documents whose referenced
  exchanges a correction must replace: quarantine every finding;
- documents whose stored file is gone: can't be re-read, so they are labelled and kept.

### Migration and rollback

**Migration 0039 adds:**
- `depositions.evidence_hold` and `evidence_epoch`;
- `analyses.source_epochs` and `case_runs.source_epochs`;
- the `evidence_migrations` and `evidence_quarantine` tables;
- the guard functions and triggers, on 14 derived tables (insert, update, delete) and on `depositions`.

It changes no existing row.

**What the guard doesn't cover**, since no application path does any of these:
- `TRUNCATE`;
- an `UPDATE` that moves a row to another deposition (the guard sees the new one only);
- the tables nothing derives testimony from: `topics`, `card_topics`, `candidate_topics`, `discovery_runs` and
  `adjudication_requests`.

**Rollback trusts nothing in the backup file blindly:** every row it would write must belong to the document,
and every update is scoped to it.

**Removing it** is dropping those triggers, functions, tables and columns.

**Cost** (`scripts/evidence-bench.ts`):
- batch writes within ±3%;
- single-row writes about 10–20% slower;
- no lock waits measured.

**Correcting, rolling back and recovering** a document follows `docs/evidence-correction.md`:
1. a full-database snapshot (`scripts/db-snapshot.ts`);
2. a rehearsal on a disposable copy (`scripts/evidence-rehearsal.ts`);
3. per document: the dry run, its review, the execution, the integrity check;
4. `rollback` or `release` when needed.

## Implementation note: whole-stretch reading (stretch-v2) and code safeguards (November 5, on `feature/whole-stretch-v2`, experimental)

**Status.** Experimental and off by default. packet-v1 stays the default contract. stretch-v2 is offered only where
the server sets `ALLOW_STRETCH_V2=true`, and only as a box a person ticks before a whole-case run.

**Contract.** A stretch-v2 request shows whole stretches of testimony around the triage-kept pairs, rendered once
from stored lines, with every exchange of the stretch citable (`retrieve/stretchSet.ts`, `adjudicate/stretchPrompt.ts`).
The model reports findings only, plus a per-pair ledger that attests coverage. Code verifies every citation with the
packet verifier and derives one status per pair: flagged, flagged but not verified, unclear, no conflict identified,
or incomplete (`adjudicate/stretch.ts`). Flagged pairs become ordinary packet-v1 findings, scored by the same rubric.
"No conflict identified" means the pair was read, not cleared, and is never shown as compatible. Retrieval, the
ledger, Fast and Economy execution, recovery, budgets, evidence-version fencing and coverage are packet-v1's,
unchanged.

**Safeguards (both contracts, `verify/safeguards.ts`).** A direct or inferential verdict is published as needs context,
never deleted, when:
- its quoted words are the examiner's, not adopted by a plain yes or no;
- a side is reported speech, a hypothetical or an attorney's statement;
- a side is a no-recall answer, or contains a no-recall clause;
- its own explanation concedes both statements can be true;
- it rates its own compatible alternative as established.

The model's outcome, explanation and the rules that fired stay on the finding and are shown in the run's Needs
context lane.

**Retrieval option (off).** `buildCasePool` accepts a per-session quota with a relevance floor
(`selection: { perSession: 2, minShare: 0.85 }`). It is not enabled, because its recall gain is unproven end to end.

**Measured (Nov 5, `docs/v2-accuracy-eval.md`, `docs/detection-quality.md`).**
- **Cost.** stretch-v2 reads a pair for $0.00148 and packet-v1 for $0.00468, about 3.2× cheaper.
- **Repeatability.** Similar: κ 0.74 against 0.70.
- **Detection.** stretch-v2 is not better than packet-v1 on the 16 developer-labelled pairs. Only 3 of them are
  positives, all used in development.
- **Safeguards.** In an in-sample replay of the stored replies, labelled controls published as contradictions fell
  from 5–6 to 2–3 per run, and labelled positives were kept.

**Limitations.**
- No independent human-labelled positive exists, so detection accuracy is not established for either contract.
- The safeguards were written after seeing the failures they address.
- Retrieval loses most labelled pairs at the per-item cut, and C01-type one-line answers are not recovered.
- Making stretch-v2 the default requires human labels on unseen testimony and a controlled comparison
  (`docs/detection-quality.md` §6).

## Implementation note: guided analysis and selected depositions (November 5, on `feature/guided-analysis`, for review)

The case page is one guided panel, with one step open at a time; finished steps collapse to a one-line summary with
"Change":
1. Add depositions. The sessions by witness, with dates and moves, plus Add deposition. Continue needs two ready
   sessions.
2. Choose what to analyze: the whole case (recommended, the default) or selected depositions, chosen here only.
   The estimate is prepared automatically once the choice is valid and has been unchanged for 0.9 s. Preparing
   sends nothing to a model. A change of choice cancels the estimate prepared for the old one. An estimate the person
   cancels, or one that fails, is not restarted on its own. Estimates replaced or cancelled before anything was read
   aren't listed as analyses. Estimates already prepared are saved in the browser per account
   (`client/src/lib/estimateCache.ts`), keyed by case, choice, reading and a fingerprint of the ready depositions
   (ids and file SHA-256), for 24 hours. Coming back to a choice shows its saved estimate without preparing it again.
   "Review and start" always prepares a current estimate on the server first, since that is what a limit is
   authorized against.
   Where `ALLOW_STRETCH_V2=true`, step 2 also asks for the analysis method, named for lawyers:
   - "Focused Analysis" (packet-v1): Recommended and the default.
   - "Contextual Analysis" (stretch-v2): no badge.

   Each method's card states its measured trade-off. A disclaimer under the choice says that results are potential
   inconsistencies for human review, not definitive findings. These are analysis strategies, never presented as
   different AI models.
3. Review the cost and start: choose fast or economy, and authorize a spending limit. Each mode is offered only
   when the server can run it:
   - Both modes need paid calls: the analysis key and `ALLOW_PAID_CALLS=true`.
   - Economy also needs `ALLOW_ECONOMY_ANALYSIS=true`; the worker then uses the Message Batches API.

   The API reports `paidAvailable`, `economyAvailable` and `economyBlocked` (`paid_off` or `economy_off`). The screen
   names what is missing, and never offers a mode that would stop at once.
4. The analysis and its results.

The page header no longer offers Add deposition or Analyze, and the deposition tables have no selection boxes: there
is one place to act. Test-model runs are not offered to people. The API refuses `mode: "mock"` (403 `test_runs_disabled`)
unless the server sets `ALLOW_TEST_RUNS=true`; the CLI and tests create them directly. The earlier direct start of a two-session check from the case page is replaced by this. Existing
two-session checks stay listed and open as before.

An analysis of selected depositions is a case run whose `config.scope.depositionIds` limits retrieval
(`buildCasePool` `depositionIds`) to those depositions. Every other part is the whole-case pipeline: the same model,
prompt, checks, scoring, estimate, budget, fast or economy execution, and recovery. The API refuses a selection
outside the case, one with an unready or excluded deposition, or one with fewer than two sessions.
