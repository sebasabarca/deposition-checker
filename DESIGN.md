# Deposition Checker v2: Design and Build Plan

Oct 27, 2026 · @Sebastian

## Summary

v2 turns each deposition into page:line source lines and Q/A exchanges. Two independent retrieval paths find candidate pairs, and Sonnet sees only compact evidence packets, which it must answer with exchange IDs. Code then checks the sources deterministically, keeps the model's interpretation labelled as interpretation, and scores each finding with a fixed, explainable rubric. Every model call is logged with its tokens and cost, so the demo reports measured cost instead of an estimate.

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

Path B reads only the parsed exchanges, so candidates still reach adjudication when claim tagging misses something or fails outright. The worker writes everything to Postgres, and the API and Workbench only read those rows. Verification is the one step where code, not the model, decides whether a finding's evidence is real.

## Ask 2: Real depositions without overflow, drift or hallucination

No model call sees more than about 10 pages, state lives in Postgres instead of a growing prompt, and every quote the lawyer sees is rendered from the stored source lines, never from model output. The next four sections cover the four parts: ingestion, retrieval, verification and scoring.

**Ingestion**

1. **Parser spike first (Wednesday morning). Done October 27: `pdfjs-dist` chosen provisionally; results, method and limitations in `docs/parser-spike.md`.** Run on Ellison P3171 and P3173, since the public Gates PDFs have no text layer. Original plan: take one deposition PDF, parse representative pages, rebuild at least 20 exchanges including a multi-page exchange and short answers, and compare text and page:line against the DOJ HTML version. List every formatting failure. Then choose: TypeScript (`pdfjs-dist`, or `pdftotext -layout` through a child process) or a small PyMuPDF command-line utility that writes JSON lines, run by the worker. The utility is a script, not a service. Decision rule: pick the option that reproduces at least 99% of sampled lines exactly with the correct page:line; if both do, pick TypeScript. If neither does, the approved fallback applies: the demo ingests the DOJ HTML transcript of the same sessions through a small HTML reader in `ingest/`, and the PDF parser stays in the repo with its measured accuracy and failures documented. Processing real depositions and parsing PDFs are reported as separate results, and HTML success is never presented as proof that PDF parsing works. OCR is not built; pages with no text layer are counted, not read.
2. **Source lines.** Each line stores printed page, PDF page index, line number, speaker, raw text and normalized text. Headers, footers and the line-number gutter are stripped. Pages with no text layer are recorded as `needs_ocr` and counted in the ledger, never dropped silently. Pages whose only text is a header or footer are counted separately as blank pages. **Every extracted line is stored, whether or not it belongs to an exchange**: questions, answers, objections, colloquy, parentheticals and fragments after a redaction gap all stay traceable to their page:line. Speaker is `attorney`, `witness`, `colloquy` (with the speaker's name), `parenthetical` or `unknown`. Text with an `unknown` speaker is kept, but is never treated as a witness assertion. An explicit speaker label that ingestion doesn't recognize (anything like `COURT REPORTER:`) makes the speaker `unknown`; it never inherits the previous speaker. Attorney labels may have multi-word surnames (`MR. VAN DYKE:`).
   - **Page status (approved October 27).** Every PDF page gets one explicit status: `text` (passed validation), `blank` (only a header or footer), `needs_ocr` (no text layer) or `failed` (has text but fails a layout check, with the reasons recorded). Checks run against the validated layout profile and include: line number matches the line's position, printed page present and in order, no unnumbered rows, no duplicate or out-of-range line numbers, and footer text in the expected form.
   - **Deposition status.** `ready` when every page is `text` or `blank` and at least one is `text`; `needs_review` when some pages are `text` and others are `needs_ocr` or `failed`; `unsupported` when no page is `text` (for example an image-only PDF, or a layout the profile does not match) or the file cannot be read. **Only `ready` depositions are used for contradiction analysis.** The parser does not try to handle other layouts.
   - **Processing and failed (approved October 28).** An uploaded deposition is `processing` until the worker has read it; its `page_count` and `validation` stay null until then, never placeholders. `failed` means the worker itself failed on all 3 attempts (a crash, a missing or damaged stored file, a database error), as opposed to a PDF that was read and found unusable (`unsupported`). The error is kept in `ingest_error`, and a failed deposition is re-queued only by an explicit retry. A failure is recorded only while the deposition is still `processing`, so it never overwrites a finished deposition or its evidence.
   - **Ingestion runs.** `ingest_run` is 1 at upload and goes up by one with each explicit retry. Every job carries the run it was queued for, and a job or a failure acts only while that run is current, so a late or redelivered message from an earlier run can't fail or redo a newer one. The worker checks the run again inside the save transaction, with the deposition row locked, so an attempt that was given up on while still parsing can't save over a newer run.
   - **Parser version at processing time.** A `processing` deposition has no lines yet, so its `parser_version` only records the parser that was expected. If the worker runs a different version (the parser changed between upload and processing), the deposition takes the worker's version and is ingested in place. If the file is already stored under the worker's version, the queued deposition is marked `failed` with a pointer to the existing one. A job never completes while its deposition is still `processing`.
3. **Exchanges.** A question, its answer, and any objections or colloquy become one exchange, even across page breaks, stored as first and last line IDs. Kinds are `qa`, `colloquy`, `objection` and `exhibit`. An answer longer than 40 lines is split into overlapping parts that share a `group_id`. Exchanges and parts reference source lines by ID and never copy them, so overlapping parts point at the same lines without duplicating the evidence. Each exchange records flags for incomplete context: `starts_mid_turn`, `ends_at_gap`, `no_answer`, `no_question`.
   - **Line references (approved October 27).** Each part stores its question range (`question_first_line_id`, `question_last_line_id`), its answer range (`answer_first_line_id`, `answer_last_line_id`) and its overall span (`first_line_id`, `last_line_id`). Because interruptions and redactions make ranges noncontiguous, the exact membership is stored too: `exchange_lines` lists every line of the part with its role (`question`, `answer`, `context` for objections, colloquy and parentheticals, or `unknown`). Nothing assumes that every line between two endpoints is witness testimony.
   - **Splitting long answers.** Only witness answer lines count toward the 40-line limit. Parts hold 40 answer lines and consecutive parts share 5 (answer lines 1–40, 36–75, and so on). Every part includes the full original question. Objections, interruptions and other context lines stay in their original order inside the part whose answer lines surround them, and never count toward the limit. Every witness answer line belongs to at least one part.
   - **Derived text.** Three fields are derived from the lines. `question_text` and `answer_text` are for retrieval: attorney and witness turns, one turn per line, so separate answers are never merged across an interruption. `dialogue_text` is the model input: every turn of the part in source order, labelled by speaker (`Q:`, `A:`, `MR. SCOTT:`, `UNKNOWN SPEAKER:`, `NOTE:`), so an attorney's correction or clarification stays between the answers it separates, and a later part of a split answer shows `[…]` where it resumes after the question. The stored source lines are authoritative: every quotation shown in the UI is rebuilt from them, never from derived text or model output.
4. **Idempotent by design.** A deposition is keyed by `file_sha256` plus `parser_version`. A re-run rewrites that deposition's lines and exchanges inside one transaction, so a retry can never duplicate source records.
5. **Input and storage (approved October 27).** Production ingests PDFs only. The DOJ HTML reader stays a validation tool and fallback candidate, not part of production ingestion. For the demo, uploaded PDFs are stored locally under `data/uploads/`, with an S3-ready `storage_key`. A command-line ingester is acceptable during development, but the finished application runs ingestion as a background job, so no user request waits on parsing. **Built October 28:** the upload endpoint stores the file, records the deposition as `processing` and queues a pg-boss job in the same transaction, then answers at once; a separate worker process reads and saves it. Ingestion progress is tracked by the deposition's status (`processing`, then `ready`, `needs_review`, `unsupported` or `failed`), not by `job_stages`, which arrives with the analysis jobs. pg-boss makes 3 attempts with exponential backoff and a 30-second heartbeat, so a crashed worker's job is retried within about 30 seconds. After the last attempt, the job moves to a dead-letter queue whose worker records the failure, retrying for about 3 hours if the database is down. Uploading a file already in the case returns the existing deposition without queuing it again. Requires Node 22.12 or later (pg-boss 12).

## Candidate retrieval: two independent paths

Candidates come from two paths behind one interface, and a claim the extractor missed never removes an exchange from consideration. A pair is always two exchanges from the same witness in different sessions; contradictions within one session are out of scope for this build.

**Path A: structured claims.** Input is the verified claim ledger. SQL pairs claims from the same witness in different sessions that share an entity or a normalized predicate, and that show at least one conflict signal: opposite polarity, or a different value in the same slot (date, time, place, quantity, action). The extraction prompt maps synonyms onto a short predicate vocabulary, so "never authorized the purchase" and "gave final approval" land on the same predicate (`approve`) with opposite polarity. Claims tagged `does_not_recall`, `hypothetical` or `reported_by_other` never create a polarity conflict. An asserted claim paired with a later `does_not_recall` is kept with the signal `recollection_change`, ranked last.

**Path B: original testimony.** This path reads only exchanges, so it works even if claim tagging fails completely. No user query is needed: each exchange in one session becomes a query against the witness's other sessions, run as an OR query with `ts_rank_cd` in Postgres full-text search, keeping the top 5 matches per exchange. Procedural exchanges (name and address, exhibit marking, objection-only) and exchanges with fewer than 3 content terms are skipped. Two ways of building the query are compared on Thursday instead of assuming one is better: **rare terms** (the exchange's 12 rarest content terms in the case) and **all meaningful terms** (every content term in the question and answer once stopwords and procedural words are removed, as conventional full-text search does). Both run on the same index against the same labelled pairs. The mode with the higher recall@300 becomes the default, with recall@100 as the tiebreak and all meaningful terms, the simpler one, on a full tie. Both stay available as a setting.

**Embeddings are a measured add-on, not a default.** The first build uses full-text only. Embeddings are added on Sunday only if Path B misses labelled pairs that an embedding search of those same pairs would find. Embedding every exchange of a 300-page deposition is roughly 90K tokens, so cost is not the reason to wait; the extra moving part is.

**Merging and ranking**

1. Union both lists and deduplicate on the unordered pair, stored as `exchange_a < exchange_b`.
2. Rank with reciprocal rank fusion: score = sum over lists of 1 / (60 + rank). The 60 is the standard constant from the original RRF paper; it is not tuned, which keeps the ranking explainable.
3. Cap each exchange at 3 selected pairs by default, so one long exchange cannot fill the budget. The cap is a setting to be validated, not an assumption: the evaluation reports recall before the cap, recall after it, and how many labelled relevant pairs it excluded. If it excludes any labelled relevant pair or lowers recall@300 by 5 points or more, the default is raised (5 is tried next), re-measured, and the change reported. Pairs cut by the cap are stored as deferred with the reason `cap`.
4. Select the top pairs up to the job's pair budget (default 300 for two sessions). The rest are stored as `deferred` with their rank, and the ledger shows the count.
5. Adjudicate a random sample of 20 deferred pairs per job (about $0.08). This estimates what the budget cut off instead of assuming nothing.

Entity and topic keys only ever add candidates. They never filter Path B, so a wrong event key cannot exclude evidence. Each candidate stores its sources and per-path ranks, so the evaluation can report recall for Path A alone, Path B alone, and both together.

## Evidence verification: three layers

Only the first layer is deterministic. The other two are model interpretation with deterministic cross-checks, and the UI labels them that way.

**Layer 1: source verification (code).** For each side of a verdict: the exchange ID exists, it is one of the two exchanges in the packet, its deposition belongs to the finding's witness, its line range resolves, and the model's key phrase is found in that exchange (`quoteMatchScore`). The displayed text always comes from `lines`. The result is one evidence status:

- `verified`: IDs valid and the key phrase matches exactly.
- `approximate`: IDs valid, key phrase matches at 0.6 to 0.99.
- `wrong_reference`: the phrase is found in a different exchange than the one cited.
- `unsupported`: an invalid ID, or a phrase found nowhere.

Only `verified` and `approximate` findings are scored. The other two go to an "Unverified, check manually" section with no confidence band. Layer 1 also records where the phrase sits: in the witness's answer, in a question followed by a plain affirmative answer, in a question followed by a plain denial, in a question with any other answer, or in an attorney's statement, objection or colloquy with no witness answer.

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

**Planning case.** Two 300-page sessions from one witness. These are planning assumptions, not measurements: 300 tokens per page; Claude Haiku 5.5 for tagging at $0.10 / $0.50 per million input / output tokens; Claude Sonnet 5.5 for adjudication at $2 / $10; **600 input and 300 output tokens per pair**, everything included, batched 10 pairs per call; skeptic pass off. At those assumptions, adjudicating 300 pairs costs $1.26. That is arithmetic on the assumptions, not evidence about real depositions.

| Adjudicated pairs | Tagging | Adjudication | Deferred-pair audit (20 pairs) | Total | Total with skeptic on 20% of pairs |
| --- | --- | --- | --- | --- | --- |
| 100 | $0.07 | $0.42 | $0.08 | $0.57 | $0.65 |
| 300 (default) | $0.07 | $1.26 | $0.08 | $1.41 | $1.66 |
| 1,000 | $0.07 | $4.20 | $0.08 | $4.35 | $5.19 |

**What the 600 / 300 assumption may miss.** A packet carries two whole exchanges plus 5 context lines on each side, so a long answer (split at 40 lines) can double or triple the input. Each call adds a system prompt and the verdict schema. Output is the expensive side at $10 per million tokens: every extra 100 output tokens per pair adds $0.30 per 300 pairs, and the verdict's fields plus Claude's reasoning may well exceed 300. Retries are billed and logged with their attempt number. A stress case of 1,200 input and 700 output tokens per pair costs about $2.82 to adjudicate 300 pairs; with tagging ($0.07) and the audit sample ($0.19) that is about $3.08. The $3 ceiling would then stop the job at about 290 pairs, with status `partial_budget`, and the ledger would list the other 10 as not adjudicated (budget). Other sensitivities: 450 tokens per page raises tagging to about $0.10; Sonnet for tagging raises it to about $1.30; embeddings, if added, cost under $0.01 per deposition.

**Measured on Friday's first real run.** Each adjudication call records its input, output and cache tokens and how many pairs it carried; each candidate records its packet size in tokens, estimated from its characters and calibrated against the calls. System-prompt and schema tokens are measured once per prompt version with the token-counting endpoint. The README reports, per pair, the median, 90th percentile and maximum input and output tokens; the share of cost from system prompts; the retry count; and the resulting cost per 300 pairs. The estimator then switches from the planning assumptions to these measured values.

**Shared prompts and batching are counted once.** Cost is recorded per call, and a call's system prompt and schema are inside that call's input or cache-read tokens, so they are neither repeated per pair nor left out. Job totals sum calls, never pairs. A per-pair cost, where shown, is the call's cost divided by its pairs, for display only.

**Incremental cost has no fixed price.** Adding a deposition costs its own tagging, proportional to its pages, plus adjudication of the new pairs it creates against the witness's existing sessions. That depends on how many pairs rank above the budget. A first deposition for a new witness creates no same-witness pairs at all. The app estimates the increment before running and reports the actual after.

**The naive baseline, for the video.** Comparing every pair of 10 full depositions three times is 45 pairs × 180K tokens × 3 runs, about 24M input tokens. That is roughly $49 on Sonnet 5.5 or $97 on Opus 5.5 before output, and it grows with the square of the session count. v2 grows with page count plus the pair budget the user chooses.

**Cost controls**

- **Content-hash caching.** Same file, same parser and extractor version means no new model calls.
- **Incremental indexing.** A new session is compared against stored exchanges; old sessions are never re-read.
- **Candidate deduplication** and the per-exchange cap of 3 pairs.
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
| `claims/` | Path A input: claim tagging with Haiku, key-phrase check, entities. Failure never blocks Path B. | `verify.ts` |
| `retrieve/` | `pathA.ts` (claims), `pathB.ts` (full text, rare-terms and all-terms query modes), `pathE.ts` (embeddings, off by default), `merge.ts` (dedupe, RRF, configurable cap, budget, audit sample) | Nothing |
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
tagClaims(depositionId: string): Promise<{ verified: number; rejected: number; failedBatches: number }>

// retrieval: every path implements the same interface
interface CandidateSource {
  name: 'claims' | 'fulltext' | 'embedding'
  find(witnessId: string, newDepositionId: string): Promise<RankedPair[]>
}
type PathBQueryMode = 'rare_terms' | 'all_terms'             // chosen by measured recall@K, not assumed
type RankedPair = { exchangeA: string; exchangeB: string; rank: number; signals: string[] }
mergeCandidates(lists: RankedPair[][], opts: { budget: number; perExchangeCap: number /* default 3, measured */; rrfK: 60; auditSample: 20 }):
  { selected: Candidate[]; deferred: (Candidate & { reason: 'budget' | 'cap' })[]; audit: Candidate[] }

// adjudication and verification
buildPacket(c: Candidate): EvidencePacket      // both exchanges + 5 lines of context each, IDs, witness and session metadata
adjudicate(p: EvidencePacket, jobId: string): Promise<Verdict>        // zod-validated structured output
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
          question_text, answer_text, dialogue_text, flags text[], content_terms int, tsv tsvector, embedding vector NULL)
          -- derived from lines: question_text and answer_text for retrieval, dialogue_text for model input
exchange_lines(exchange_id, line_id, role)   -- role: question | answer | context | unknown; primary key (exchange_id, line_id)
          -- tsv and its GIN index are added with Path B; embedding only if embeddings are switched on
entities(id, case_id, kind, canonical_name, aliases text[])
claims(id, exchange_id, witness_id, subject, predicate, object, polarity, epistemic_status,
       time_range tstzrange NULL, place, quantity, entity_ids int[], key_phrase, match_score, status, extractor_version)
candidates(id, job_id, witness_id, exchange_a, exchange_b, sources text[],
           rank_claims int NULL, rank_fulltext int NULL, rank_embedding int NULL, rrf_score real,
           packet_tokens int NULL, status, deferred_reason NULL)
           -- status: selected | deferred | audit | adjudicated; deferred_reason: budget | cap; check (exchange_a < exchange_b)
verdicts(id, candidate_id, model, prompt_version, raw jsonb, created_at)        -- the model's output, kept as received
findings(id, case_id, candidate_id, verdict_id, type, evidence_status, attribution_a, attribution_b,
         score int NULL, band NULL, factors jsonb, caps jsonb, rubric_version, priority, review_state)
         -- attribution_a/b hold the combined level: clear | qualified | uncertain | not_adopted | no_recall
reviews(id, finding_id, user_id, decision, note, created_at)                    -- human decisions, apart from AI output
jobs(id, case_id, status, budget_usd, spent_usd, counts jsonb, error)
     -- status: queued | running | partial_budget | partial_failed | complete | failed
job_stages(job_id, deposition_id, stage, status, attempts, input_hash, completed_at)  -- unique (job_id, deposition_id, stage)
llm_calls(id, job_id NULL, stage, model, items int, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
          batch bool, attempt, price_version NULL, cost_usd NULL, created_at)     -- items: pairs or exchanges in the call
          -- price_version and cost_usd are null together for a model missing from the price table (unpriced, never free)
eval_labels(id, set_name, is_synthetic bool, exchange_a, exchange_b, label, expected_type NULL, note)
case_summary(case_id, counts jsonb, cost_usd, updated_at)
```

**Indexes:** `lines (deposition_id, printed_page, line_no)` unique; `exchanges (witness_id, deposition_id)`; GIN on `exchanges.tsv` (added with Path B); `claims (witness_id, predicate)` and GIN on `claims.entity_ids`; `candidates (witness_id, exchange_a, exchange_b)` unique within a job; `findings (case_id, review_state, priority, score DESC, id)` for the navigator; `llm_calls (job_id, stage)`. HNSW on `exchanges.embedding` only once embeddings are switched on.

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

**Real testimony (Ellison P3171 and P3173).** Label exchange pairs in these categories: potentially contradictory, related but compatible, different events, ambiguous, qualified, lack of recollection, and relevant pairs that retrieval should surface whatever their label. Target about 40 labelled pairs, with no quota for contradictions. If only three genuine ones exist, the set has three. Labels go in `eval_labels` with `is_synthetic = false`. Time box: 2 to 3 hours on Thursday, finding pairs with Path B's search.

**Synthetic regression fixtures.** The v1 Marcus Webb and Elena Ruiz sets with their answer keys, plus about 8 adversarial cases written for v2: a "don't remember" trap, a phrase that appears only in the attorney's question, a plain "No." that a careless reader could take as agreement, a "Yes." that adopts the question, the same time but different events, a paraphrased contradiction ("never authorized" against "gave final approval"), a citation to the wrong exchange, and a fabricated quote. Stored with `is_synthetic = true` and always reported separately.

| Metric | Definition | Data |
| --- | --- | --- |
| Q/A reconstruction accuracy (PDF parser) | Share of sampled exchanges whose boundaries, text and page:line from the PDF match the DOJ HTML version; reported even if the demo uses the HTML fallback | At least 20 exchanges from the spike, at least 60 by the final run |
| Source citation validity | Share of findings whose cited lines resolve and render text identical to the source | Every finding produced |
| Retrieval recall@K | Share of labelled relevant pairs found among the top K ranked candidates, for K = 100, 300, 1,000; reported for Path A, Path B, and both | Real labels |
| Path B query mode | Recall@K for rare-term queries against all-meaningful-term queries, on the same labels and K | Real labels |
| Per-exchange cap effect | Recall@300 before and after the cap, and the number of labelled relevant pairs the cap excluded | Real labels |
| Path contribution | Labelled pairs found by only one path | Real and synthetic |
| Classification precision | Of findings classified direct or inferential, the share labelled potentially contradictory; per band | Real and synthetic, reported separately |
| False-positive handling | Of adjudicated compatible or different-event pairs, the share classified false positive or needs more context | Real and synthetic |
| Uncertainty handling | Of adjudicated no-recall, qualified or ambiguous pairs, the share not classified direct | Real and synthetic |
| Cost per analysis | Actual cost by stage from `llm_calls`, with per-pair input and output token distributions | Each real run |

## Acceptance criteria

| Area | Criterion | How it is shown |
| --- | --- | --- |
| Real depositions | Genuine sworn testimony (both Ellison sessions, P3171 and P3173) is ingested and analyzed end to end, and the case page and README name the source format used (PDF or DOJ HTML) | Ledger counts on the case page; README |
| PDF ingestion | Claimed only if the chosen parser reproduces at least 99% of sampled lines with the correct page:line on real DOJ PDFs. Otherwise the README says the demo used DOJ HTML and reports the PDF parser's measured accuracy and failure types | Spike report; Q/A accuracy metric |
| Ingestion | Exchanges keep their source references, including multi-page exchanges | Q/A accuracy metric, at least 60 exchanges |
| Ingestion | Pages without a text layer are reported, never silently dropped (no OCR) | Test with a page that has no text layer |
| Retrieval | Both paths produce candidates, and Path B works with claim tagging switched off | Test run with `tagClaims` disabled |
| Retrieval | Path B query mode (rare terms or all meaningful terms) chosen by measured recall@K; recall@K reported per path; target 80% at K = 300 | Eval script output with n |
| Retrieval | Per-exchange cap effect reported (recall before and after, labelled pairs excluded); cap raised if it excludes labelled pairs or costs 5 points of recall@300 | Eval script output with n |
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
2. **Case overview.** Sessions per witness with their dates and source format (PDF or DOJ HTML), job progress by stage, a "partial analysis" banner when a job stopped on budget or failure ("Partial: 290 of 300 pairs adjudicated, budget reached"), and the coverage ledger: pages parsed and failed, exchanges indexed, claim batches done and failed, candidates generated, deduplicated, adjudicated, deferred (by budget or by cap) and audited, findings verified, and estimated versus actual cost. It says plainly that full processing is not proof that every contradiction was found.
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
- Use Codex as a second reviewer on each pull request, and a hook that runs `npm run typecheck` and `npm test` before every commit.
- Keep `docs/agent-log.md`: the prompt, what the agent got wrong, what you changed. The v1 `tq_id` story shows Edward this is the skill he is hiring for.

**Day by day**

- [x] **Tue Oct 27:** repository audit and design (done).
- [x] **Wed Oct 28, morning: parser spike, decision by 1 p.m.** (done October 27) Commit `CLAUDE.md` and `DESIGN.md`. Get one deposition PDF and its DOJ HTML version (done on Ellison P3171 and P3173; see `docs/parser-spike.md`). Parse representative pages and rebuild at least 20 exchanges, including a multi-page exchange and short answers. Compare text and page:line against the HTML, list the formatting failures, and choose TypeScript or the PyMuPDF utility by the rule in Ingestion. If neither passes, switch the demo input to the DOJ HTML transcripts (approved fallback) and keep the PDF results for the README.
- [ ] **Wed Oct 28, afternoon:** Docker Compose (Postgres with pgvector), Drizzle schema and migrations, `ingest/` for lines and exchanges with fixture tests (CLI ingestion for now; the pg-boss worker with `job_stages` and the upload endpoint move to the next stage, approved October 27, and remain required), `costs/` price table and `recordCall` (no model calls yet). *End of day:* both Ellison depositions ingested from the CLI as `ready`, with their lines and exchanges in Postgres.
- [ ] **Thu Oct 29:** Path B full-text retrieval first, in both query modes, so candidates exist without any claims. Then Path A: claim tagging with epistemic status, key-phrase checks, structured retrieval. Then `merge.ts` (RRF, configurable cap, budget, deferred, audit sample). You label the real evaluation set (2 to 3 hours) while an agent writes the synthetic adversarial fixtures. *End of day:* ranked candidates for Ellison P3171 and P3173, with recall@K per path and per Path B query mode on the first labels, and the cap-effect numbers.
- [ ] **Fri Oct 30, milestone:** packets, Sonnet adjudication, Layer 1 and 2 verification (including `readAnswer`), the ledger, budget guard and partial status, estimate endpoint, plus a plain findings list in the UI. Scoring is test-first: write the 16 required scoring tests from the test table (20 with variants) and the `readAnswer` unit tests, commit them failing, then implement `score()` and `prioritize()` until they pass. *End of day:* end-to-end run on Ellison P3171 and P3173 with verified citations, classified findings, calculated scores and measured cost, including per-pair token distributions.
- [ ] **Sat Oct 31:** Contradiction Workbench: navigator, side-by-side passages, assessment panel, review states, unverified section, case overview with the ledger.
- [ ] **Sun Nov 1:** full evaluation run and fixes (Path B query mode confirmed on the full label set; per-exchange cap changed only if it excluded labelled pairs; embeddings only if Path B recall is under target); dashboard and `case_summary`; indexes and seed data; k6 with a job running; kill-the-worker test; budget-exceeded test.
- [ ] **Mon Nov 2:** `ARCHITECTURE.md` and README with measured cost and token distributions, k6 results, evaluation metrics with n, the source format tested (PDF or DOJ HTML) with the PDF parser's measured accuracy, limitations, and the agent workflow; record and caption the video, which names the format it ran on.
- [ ] **Tue Nov 3:** buffer. Stretch features in backlog order only if every acceptance criterion passes. Fresh-clone test, then send the reply to Edward by mid-afternoon Pacific.

## Risks and fallbacks

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| PDF parsing misses lines or page:line on real files | Medium | Approved fallback: ingest the DOJ HTML transcripts for the demo. The README and video say the demo ran on HTML and report the PDF parser's measured accuracy separately; HTML success is never presented as PDF parsing. |
| Path B returns too many weak pairs, or misses paraphrases | Medium | Both query modes compared on labels; per-exchange cap measured; procedural filter; Path A catches paraphrases through the predicate vocabulary; embeddings only if measured recall justifies them. |
| Few genuine contradictions in Ellison P3171 and P3173 | High | Real labels still measure retrieval, false-positive handling and uncertainty. Precision on contradictions also comes from synthetic fixtures, reported separately with n. |
| Adjudicator misreads attribution, including yes-or-no answers | Medium | Code reads plain yes and no answers itself; the lower of the code's and Claude's reading wins; a stance mismatch or a no-recall answer caps the score at 40. |
| The answer reader is too strict or too loose (tag questions, compound questions, "Uh-huh") | Medium | Anything other than a plain yes or no stays uncertain (cap 70, never High). Unit tests use real Ellison answers. Compound questions ("Did you read and approve it?") are a documented limit. |
| Packets and outputs are larger than planned, so cost overshoots | Medium | Measured on Friday; the budget guard stops with a disclosed partial status; then lower the default pair budget or context lines, or use the Haiku triage lever. |
| Workbench UI takes longer than Saturday | High | A plain findings list exists from Friday; stretch UI features wait. |
| Load test machine limits | Medium | Run locally in Docker, publish the machine specs, and label results as tested on one machine. |

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

## Decisions (approved October 28)

All four previously open decisions are approved. Planning is complete, and implementation starts with the Wednesday parser spike.

- [x] **Rubric v1, approved provisionally.** It includes the attribution caps, yes-or-no handling and recomputed test values in Confidence scoring. Weights, caps and thresholds are frozen for the initial evaluation; any later change ships as a new, explained rubric version.
- [x] **Default budgets.** 300 adjudicated pairs, a $3 maximum per two-session analysis, and 20 deferred pairs sampled for audit. All configurable, and revisited against measured token use and retrieval coverage.
- [x] **Parser fallback.** Use the DOJ HTML transcript when PDF extraction misses the source-fidelity threshold, and document the limitation openly.
- [x] **Pair scope.** Same witness across different deposition sessions only. Within-session contradictions and cross-witness discrepancies stay out of the core build.

**Testing budget.** About $30 of Anthropic API use during development, tracked through `llm_calls` and checked daily, with every job under its own budget guard.
