// Database schema for ingestion (DESIGN.md, "Modules, schema and interfaces").
// Only the tables ingestion needs. Retrieval, jobs, findings and users add their own tables
// later; the full-text tsv column and its index arrive with Path B.
//
// Source lines are the evidence. Exchanges point at lines by ID, never copy them, and may only
// point at lines of their own deposition; exchange_lines records exactly which lines belong to
// each exchange part and in what role.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  real,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Validation } from "../ingest/validate";
import { CARD_EPISTEMIC, CARD_STANCES, CLAIM_SOURCES, EPISTEMIC, POLARITIES, PREDICATE_NAMES } from "../claims/vocabulary";

// processing: uploaded, waiting for or in the ingest worker. ready / needs_review / unsupported:
// what validation decided about the file. failed: the worker itself failed (a crash or an
// outage, not a bad PDF) on every attempt; the error is in ingest_error, and it can be retried.
export const depositionStatus = pgEnum("deposition_status", [
  "processing",
  "ready",
  "needs_review",
  "unsupported",
  "failed",
]);
export const sourceFormat = pgEnum("source_format", ["pdf", "html"]);
export const speakerRole = pgEnum("speaker_role", [
  "attorney",
  "witness",
  "colloquy",
  "parenthetical",
  "unknown",
]);
export const exchangeKind = pgEnum("exchange_kind", [
  "qa",
  "colloquy",
  "objection",
  "exhibit",
]);
export const lineRole = pgEnum("line_role", [
  "question",
  "answer",
  "context",
  "unknown",
]);

// Postgres full-text search vector. Drizzle has no built-in type for it.
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () =>
  bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: "number" });
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const cases = pgTable(
  "cases",
  {
    id: id(),
    orgId: ref("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("cases_org_id_idx").on(t.orgId)],
);

export const witnesses = pgTable(
  "witnesses",
  {
    id: id(),
    caseId: ref("case_id")
      .notNull()
      .references(() => cases.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("witnesses_case_name_unique").on(t.caseId, t.name),
    // Target for depositions' (witness_id, case_id) foreign key.
    unique("witnesses_id_case_unique").on(t.id, t.caseId),
  ],
);

export const depositions = pgTable(
  "depositions",
  {
    id: id(),
    caseId: ref("case_id")
      .notNull()
      .references(() => cases.id),
    witnessId: ref("witness_id").notNull(),
    takenOn: date("taken_on"), // null when the transcript doesn't state it (P3173)
    fileSha256: text("file_sha256").notNull(),
    storageKey: text("storage_key").notNull(), // path under data/uploads/ now; an S3 key later
    originalFilename: text("original_filename"), // as uploaded; null for depositions stored before it was kept
    sourceFormat: sourceFormat("source_format").notNull().default("pdf"),
    // page_count and validation are null until the file has been read (status processing, or failed
    // before any attempt finished); never a placeholder.
    pageCount: integer("page_count"),
    needsOcrPages: integer("needs_ocr_pages")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    blankPages: integer("blank_pages")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    validation: jsonb("validation").$type<Validation>(), // per-page statuses and failure reasons
    parserVersion: text("parser_version").notNull(),
    status: depositionStatus("status").notNull(),
    ingestError: text("ingest_error"), // why the worker failed; set only while status is failed
    // Which ingestion run is current: 1 at upload, plus one for each explicit retry. Every queued
    // job carries the run it was queued for, and acts only while that run is still current, so a
    // late or redelivered message from an earlier run can't affect a newer one.
    ingestRun: integer("ingest_run").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    // Duplicate protection: the same file parsed by the same parser version is ingested once per case.
    unique("depositions_file_unique").on(
      t.caseId,
      t.fileSha256,
      t.parserVersion,
    ),
    // The witness must belong to the deposition's case.
    foreignKey({
      name: "depositions_witness_case_fk",
      columns: [t.witnessId, t.caseId],
      foreignColumns: [witnesses.id, witnesses.caseId],
    }),
    index("depositions_witness_id_idx").on(t.witnessId),
    // Target for exchanges' (deposition, witness) foreign key.
    unique("depositions_id_witness_unique").on(t.id, t.witnessId),
    check(
      "depositions_file_sha256_check",
      sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    // A read file has both its page count and its validation report; only processing and failed
    // depositions may have neither. The status is compared as text so this migration can run in
    // the same transaction that adds the 'failed' value.
    check(
      "depositions_read_check",
      sql`(${t.validation} is null) = (${t.pageCount} is null) and (${t.validation} is not null or ${t.status}::text in ('processing', 'failed'))`,
    ),
    check(
      "depositions_ingest_error_check",
      sql`(${t.status}::text = 'failed') = (${t.ingestError} is not null)`,
    ),
  ],
);

export const lines = pgTable(
  "lines",
  {
    id: id(),
    depositionId: ref("deposition_id")
      .notNull()
      .references(() => depositions.id, { onDelete: "cascade" }),
    pdfPage: integer("pdf_page").notNull(),
    printedPage: integer("printed_page").notNull(),
    lineNo: integer("line_no").notNull(),
    speakerRole: speakerRole("speaker_role").notNull(),
    speakerName: text("speaker_name"),
    rawText: text("raw_text").notNull(), // as extracted, without the line-number gutter; the evidence
    ocrText: text("ocr_text"), // what OCR read, when a correction made raw_text differ from it
    normText: text("norm_text").notNull(), // lowercased, punctuation removed; for matching only
    ocrConfidence: integer("ocr_confidence"), // 0-100 for a line read by OCR, whose text may differ from the scan; null for a text layer
  },
  (t) => [
    unique("lines_page_line_unique").on(
      t.depositionId,
      t.printedPage,
      t.lineNo,
    ),
    // Target for the (line, deposition) foreign keys in exchanges and exchange_lines.
    unique("lines_id_deposition_unique").on(t.id, t.depositionId),
    check("lines_line_no_check", sql`${t.lineNo} >= 1`),
  ],
);

// A reference from an exchange to one of its lines. The foreign key covers the pair
// (line, deposition), so an exchange can only point at lines from its own deposition.
const lineInSameDeposition = (
  name: string,
  lineId: AnyPgColumn,
  depositionId: AnyPgColumn,
) =>
  foreignKey({
    name,
    columns: [lineId, depositionId],
    foreignColumns: [lines.id, lines.depositionId],
  });

export const exchanges = pgTable(
  "exchanges",
  {
    id: id(),
    depositionId: ref("deposition_id")
      .notNull()
      .references(() => depositions.id, { onDelete: "cascade" }),
    // Copied from the deposition so retrieval can find a witness's exchanges across sessions;
    // the foreign key below keeps it equal to the deposition's witness.
    witnessId: ref("witness_id").notNull(),
    groupId: integer("group_id").notNull(), // shared by all parts of one exchange, numbered within the deposition
    partNo: integer("part_no").notNull(),
    partCount: integer("part_count").notNull(),
    kind: exchangeKind("kind").notNull(),
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Endpoints only: the lines between them are not all part of the exchange (see exchange_lines).
    // Each must be a line of this deposition (foreign keys below).
    firstLineId: ref("first_line_id").notNull(),
    lastLineId: ref("last_line_id").notNull(),
    questionFirstLineId: ref("question_first_line_id"),
    questionLastLineId: ref("question_last_line_id"),
    answerFirstLineId: ref("answer_first_line_id"),
    answerLastLineId: ref("answer_last_line_id"),
    answerLineCount: integer("answer_line_count").notNull(),
    // Derived from the lines; never displayed as evidence.
    questionText: text("question_text").notNull(), // retrieval
    answerText: text("answer_text").notNull(), // retrieval
    dialogueText: text("dialogue_text").notNull(), // model input
    // Path B's full-text index over the retrieval text, kept in sync by Postgres. The English
    // configuration stems words and drops common English stopwords; courtroom words are removed
    // at query time (retrieve/procedural.ts), so changing that list never needs a migration.
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english'::regconfig, question_text || ' ' || answer_text)`),
  },
  (t) => [
    unique("exchanges_part_unique").on(t.depositionId, t.groupId, t.partNo),
    // Target for exchange_lines' (exchange, deposition) foreign key.
    unique("exchanges_id_deposition_unique").on(t.id, t.depositionId),
    foreignKey({
      name: "exchanges_deposition_witness_fk",
      columns: [t.depositionId, t.witnessId],
      foreignColumns: [depositions.id, depositions.witnessId],
    }).onDelete("cascade"),
    index("exchanges_witness_deposition_idx").on(t.witnessId, t.depositionId),
    index("exchanges_tsv_idx").using("gin", t.tsv),
    // Null question or answer endpoints skip their check (Postgres MATCH SIMPLE).
    lineInSameDeposition("exchanges_first_line_fk", t.firstLineId, t.depositionId),
    lineInSameDeposition("exchanges_last_line_fk", t.lastLineId, t.depositionId),
    lineInSameDeposition("exchanges_question_first_line_fk", t.questionFirstLineId, t.depositionId),
    lineInSameDeposition("exchanges_question_last_line_fk", t.questionLastLineId, t.depositionId),
    lineInSameDeposition("exchanges_answer_first_line_fk", t.answerFirstLineId, t.depositionId),
    lineInSameDeposition("exchanges_answer_last_line_fk", t.answerLastLineId, t.depositionId),
    check(
      "exchanges_part_no_check",
      sql`${t.partNo} between 1 and ${t.partCount}`,
    ),
    check(
      "exchanges_question_range_check",
      sql`(${t.questionFirstLineId} is null) = (${t.questionLastLineId} is null)`,
    ),
    check(
      "exchanges_answer_range_check",
      sql`(${t.answerFirstLineId} is null) = (${t.answerLastLineId} is null)`,
    ),
    check(
      "exchanges_answer_line_count_check",
      sql`${t.answerLineCount} between 0 and 40`,
    ),
  ],
);

export const exchangeLines = pgTable(
  "exchange_lines",
  {
    exchangeId: ref("exchange_id").notNull(),
    lineId: ref("line_id").notNull(),
    // Stored so both foreign keys below can require the exchange and the line to share it.
    depositionId: ref("deposition_id").notNull(),
    role: lineRole("role").notNull(),
  },
  (t) => [
    primaryKey({
      name: "exchange_lines_pk",
      columns: [t.exchangeId, t.lineId],
    }),
    foreignKey({
      name: "exchange_lines_exchange_fk",
      columns: [t.exchangeId, t.depositionId],
      foreignColumns: [exchanges.id, exchanges.depositionId],
    }).onDelete("cascade"),
    lineInSameDeposition("exchange_lines_line_fk", t.lineId, t.depositionId).onDelete("cascade"),
    // Find every exchange part a line belongs to (a line can be in two overlapping parts).
    index("exchange_lines_line_id_idx").on(t.lineId),
  ],
);

export const llmStage = pgEnum("llm_stage", ["claim_tagging", "adjudication", "statement_cards", "topic_mapping", "discovery"]);

// One row per successful model call (DESIGN.md, "Cost model"). Cost is computed when the call is
// recorded, with the price version it used, so a later price change never rewrites it. A model
// missing from the price table is still recorded, with its tokens, as unpriced: cost_usd and
// price_version are null, and totals report it rather than counting it as free.
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: id(),
    // The analysis job. No foreign key yet: the jobs table arrives with analysis jobs, and the key is
    // added then, once existing values are checked. Same type as every other ID here (bigint).
    jobId: ref("job_id"),
    stage: llmStage("stage").notNull(),
    model: text("model").notNull(),
    items: integer("items").notNull(), // pairs or exchanges carried by the call
    inputTokens: integer("input_tokens").notNull(), // uncached input only
    outputTokens: integer("output_tokens").notNull(),
    cacheWrite5mTokens: integer("cache_write_5m_tokens").notNull(),
    cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    batch: boolean("batch").notNull().default(false),
    attempt: integer("attempt").notNull(), // 1 for the first try; retries are billed too
    thinkingTokens: integer("thinking_tokens"), // the part of outputTokens spent thinking, when the API reports it
    effort: text("effort"), // the output_config.effort the call was made with, when set
    latencyMs: integer("latency_ms"), // wall-clock time of the request
    rawOutput: text("raw_output"), // the response's text as received, for diagnosing extraction (null when none)
    priceVersion: text("price_version"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8, mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("llm_calls_job_stage_idx").on(t.jobId, t.stage),
    check(
      "llm_calls_tokens_check",
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheWrite5mTokens} >= 0 and ${t.cacheWrite1hTokens} >= 0 and ${t.cacheReadTokens} >= 0`,
    ),
    check("llm_calls_counts_check", sql`${t.items} >= 1 and ${t.attempt} >= 1`),
    // Priced calls have both a cost and the price version behind it; unpriced calls have neither.
    check("llm_calls_priced_check", sql`(${t.costUsd} is null) = (${t.priceVersion} is null) and (${t.costUsd} is null or ${t.costUsd} >= 0)`),
  ],
);

// Path A: claims extracted from witness testimony (DESIGN.md, "Candidate retrieval"). The model's
// reading is kept apart from what code verified: status, scores, reasons and evidence lines are code's.
export const claimPredicate = pgEnum("claim_predicate", PREDICATE_NAMES);
export const claimPolarity = pgEnum("claim_polarity", POLARITIES);
export const claimEpistemic = pgEnum("claim_epistemic", EPISTEMIC);
export const claimSource = pgEnum("claim_source", CLAIM_SOURCES);
export const claimStatus = pgEnum("claim_status", ["verified", "approximate", "rejected"]);
export const taggingStatus = pgEnum("tagging_status", ["tagged", "failed", "refused"]);

export const claims = pgTable(
  "claims",
  {
    id: id(),
    // The exchange part the model cited. Null only for a rejected claim citing a part that wasn't in
    // its batch; citedExchange then keeps what the model wrote.
    exchangeId: ref("exchange_id"),
    citedExchange: text("cited_exchange").notNull(),
    depositionId: ref("deposition_id").notNull(),
    witnessId: ref("witness_id").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    ordinal: integer("ordinal").notNull(), // position in the model's output for that part
    // The model's reading.
    source: claimSource("source").notNull(),
    keyPhrase: text("key_phrase").notNull(), // the witness's words, or the question an answer adopted
    answerPhrase: text("answer_phrase"), // adopted_question only: the witness's yes or no
    subject: text("subject").notNull(),
    predicate: claimPredicate("predicate").notNull(),
    object: text("object"),
    polarity: claimPolarity("polarity").notNull(),
    epistemic: claimEpistemic("epistemic").notNull(),
    time: text("time"), // as stated; ambiguity.ts compares times as written
    place: text("place"),
    quantity: text("quantity"),
    entities: text("entities").array().notNull().default(sql`'{}'::text[]`), // normalized names grounded in the exchange's words
    ungroundedEntities: text("ungrounded_entities").array().notNull().default(sql`'{}'::text[]`), // named by the model but not in the exchange
    dependsOnEarlier: boolean("depends_on_earlier"), // the model's reading; null for extractor versions that didn't ask
    // Code's verification against the stored source lines.
    status: claimStatus("status").notNull(),
    rejectionReason: text("rejection_reason"),
    matchScore: real("match_score").notNull(),
    answerMatchScore: real("answer_match_score"),
    evidenceLineIds: bigint("evidence_line_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
    hedge: text("hedge"), // a hedge code found governing the key phrase ("I think"); null when none
    // Code's finding that the claim's meaning depends on an earlier exchange outside its evidence.
    // Such claims are kept and counted but never enter retrieval.
    contextDependent: boolean("context_dependent").notNull().default(false),
    contextReason: text("context_reason"),
    llmCallId: ref("llm_call_id")
      .notNull()
      .references(() => llmCalls.id),
    createdAt: createdAt(),
  },
  (t) => [
    // One row per claim of a model response. Re-tagging a part replaces its claims by exchange_id.
    unique("claims_response_unique").on(t.llmCallId, t.citedExchange, t.ordinal),
    // A cited part must be in the claim's deposition, and the deposition the witness's.
    foreignKey({
      name: "claims_exchange_fk",
      columns: [t.exchangeId, t.depositionId],
      foreignColumns: [exchanges.id, exchanges.depositionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "claims_deposition_witness_fk",
      columns: [t.depositionId, t.witnessId],
      foreignColumns: [depositions.id, depositions.witnessId],
    }).onDelete("cascade"),
    index("claims_witness_predicate_idx").on(t.witnessId, t.predicate),
    index("claims_entities_idx").using("gin", t.entities),
    check("claims_rejected_check", sql`(${t.status}::text = 'rejected') = (${t.rejectionReason} is not null)`),
    check("claims_exchange_check", sql`${t.exchangeId} is not null or ${t.status}::text = 'rejected'`),
    check("claims_answer_phrase_check", sql`(${t.source}::text = 'adopted_question') = (${t.answerPhrase} is not null)`),
    check("claims_context_check", sql`${t.contextDependent} = (${t.contextReason} is not null)`),
  ],
);

// One row per exchange part attempted by an extractor version: whether it was tagged, failed or
// refused. Every attempt is counted, and a re-run of the same version skips the tagged parts.
export const claimTagging = pgTable(
  "claim_tagging",
  {
    exchangeId: ref("exchange_id").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    depositionId: ref("deposition_id").notNull(),
    status: taggingStatus("status").notNull(),
    claims: integer("claims").notNull().default(0), // claims the model returned for the part
    error: text("error"), // why it failed or was refused
    llmCallId: ref("llm_call_id").references(() => llmCalls.id), // null when no response came back
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "claim_tagging_pk", columns: [t.exchangeId, t.extractorVersion] }),
    foreignKey({
      name: "claim_tagging_exchange_fk",
      columns: [t.exchangeId, t.depositionId],
      foreignColumns: [exchanges.id, exchanges.depositionId],
    }).onDelete("cascade"),
    index("claim_tagging_deposition_idx").on(t.depositionId, t.extractorVersion),
    check("claim_tagging_error_check", sql`(${t.status}::text = 'tagged') = (${t.error} is null)`),
  ],
);

// Budgets for paid model calls (DESIGN.md, "Per-job budget, enforced"). A budget's spent amount is
// reconciled actual cost; its reserved amount is the worst-case cost of calls in flight. A call may
// be dispatched only after its worst case is reserved, atomically: spent + reserved + the new
// reservation must stay within the limit, so concurrent workers can never overspend it together.
export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    name: text("name").notNull().unique(),
    limitUsd: numeric("limit_usd", { precision: 14, scale: 8, mode: "number" }).notNull(),
    spentUsd: numeric("spent_usd", { precision: 14, scale: 8, mode: "number" }).notNull().default(0),
    reservedUsd: numeric("reserved_usd", { precision: 14, scale: 8, mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    // The limit is enforced where reservations are made (costs/budget.ts), not here: settling a call
    // whose actual cost exceeded its reservation must never fail.
    check("budgets_amounts_check", sql`${t.limitUsd} >= 0 and ${t.spentUsd} >= 0 and ${t.reservedUsd} >= 0`),
  ],
);

// One row per paid request: reserved before dispatch, then settled at its actual cost, released
// when the request certainly wasn't billed, or kept as uncertain (counted at its full reservation)
// when it's unknown whether it was. A reservation left `reserved` by a crash keeps counting until
// reconciled.
export const reservationStatus = pgEnum("reservation_status", ["reserved", "settled", "released", "uncertain"]);
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: id(),
    budgetId: ref("budget_id")
      .notNull()
      .references(() => budgets.id),
    purpose: text("purpose").notNull(), // e.g. "claim_tagging deposition 1, 12 parts"
    maxUsd: numeric("max_usd", { precision: 14, scale: 8, mode: "number" }).notNull(),
    actualUsd: numeric("actual_usd", { precision: 14, scale: 8, mode: "number" }),
    status: reservationStatus("status").notNull().default("reserved"),
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    note: text("note"), // why it was released or left uncertain
    createdAt: createdAt(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    index("budget_reservations_budget_idx").on(t.budgetId, t.status),
    check("budget_reservations_max_check", sql`${t.maxUsd} >= 0`),
  ],
);

// Merged retrieval candidates (DESIGN.md, "Merging and ranking"), stored so a verdict always points
// back to the exact evidence retrieval found. Until analysis jobs exist, candidates are grouped in a
// named set instead of a job. exchange_a / exchange_b are the representative parts of the two logical
// exchanges; evidence keeps every path's parts, claims and signals.
// status is the candidate's assessment state: selected (awaiting assessment), adjudicated (assessed),
// deferred (with deferred_reason), excluded (with exclusion_reason), audit.
export const candidateStatus = pgEnum("candidate_status", ["selected", "deferred", "audit", "adjudicated", "excluded"]);
export const candidates = pgTable(
  "candidates",
  {
    id: id(),
    candidateSet: text("candidate_set").notNull(),
    jobId: ref("job_id"), // null until analysis jobs exist
    witnessId: ref("witness_id").notNull(),
    depositionA: ref("deposition_a").notNull(),
    groupA: integer("group_a").notNull(),
    depositionB: ref("deposition_b").notNull(),
    groupB: integer("group_b").notNull(),
    exchangeA: ref("exchange_a").notNull(),
    exchangeB: ref("exchange_b").notNull(),
    sources: text("sources").array().notNull(),
    rankClaims: integer("rank_claims"),
    rankFulltext: integer("rank_fulltext"),
    rankTopics: integer("rank_topics"), // rank within Path A's topic retrieval
    rrfScore: real("rrf_score").notNull(),
    mergedRank: integer("merged_rank").notNull(),
    evidence: jsonb("evidence").notNull(), // every path's evidence, as retrieval returned it
    status: candidateStatus("status").notNull().default("selected"),
    deferredReason: text("deferred_reason"),
    exclusionReason: text("exclusion_reason"),
    retrievalVersion: text("retrieval_version"), // null on candidates from before versioned retrieval
    mapVersion: integer("map_version"), // the topic map Path A used
    selectedBy: text("selected_by"), // whose share of the budget selected it
    createdAt: createdAt(),
  },
  (t) => [
    unique("candidates_pair_unique").on(t.candidateSet, t.depositionA, t.groupA, t.depositionB, t.groupB),
    foreignKey({ name: "candidates_exchange_a_fk", columns: [t.exchangeA, t.depositionA], foreignColumns: [exchanges.id, exchanges.depositionId] }).onDelete("cascade"),
    foreignKey({ name: "candidates_exchange_b_fk", columns: [t.exchangeB, t.depositionB], foreignColumns: [exchanges.id, exchanges.depositionId] }).onDelete("cascade"),
    check("candidates_order_check", sql`(${t.depositionA}, ${t.groupA}) < (${t.depositionB}, ${t.groupB})`),
    check("candidates_excluded_check", sql`(${t.status}::text = 'excluded') = (${t.exclusionReason} is not null)`),
    check("candidates_selected_by_check", sql`${t.selectedBy} is null or ${t.selectedBy} in ('path_a', 'path_b')`),
  ],
);

// The model's output for a candidate, kept as received (DESIGN.md `verdicts`), whether or not it
// passed the strict schema. Only a valid verdict becomes a finding.
export const verdictStatus = pgEnum("verdict_status", ["valid", "schema_invalid", "refused", "cut_off"]);
export const verdicts = pgTable(
  "verdicts",
  {
    id: id(),
    candidateId: ref("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    model: text("model").notNull(), // the model that answered, as the response reported it
    promptVersion: text("prompt_version").notNull(),
    effort: text("effort").notNull(),
    status: verdictStatus("status").notNull(),
    raw: text("raw"), // the response text as received
    parsed: jsonb("parsed"), // the validated verdict, when valid
    error: text("error"), // why it isn't valid
    // A valid verdict whose own fields contradict each other (adjudicate/consistency.ts): kept as
    // received, its finding unscored for review.
    consistencyIssues: text("consistency_issues")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    packet: jsonb("packet").notNull(), // the evidence packet sent: exchange IDs and the line IDs shown
    // Where the verdict came from. Only `model` is a model's answer to this candidate, made with a
    // recorded call. Demo analyses never call a model: `replayed` copies a stored model verdict for
    // the same pair of exchanges (replay_of), and `fixture` is a prepared synthetic verdict written
    // by hand for a test suite. The UI labels both as such; neither is ever shown as live output.
    origin: text("origin").notNull().default("model"),
    replayOf: ref("replay_of"),
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    requestId: ref("request_id").references(() => adjudicationRequests.id), // the request that produced it, when recorded
    createdAt: createdAt(),
  },
  (t) => [
    check("verdicts_valid_check", sql`(${t.status}::text = 'valid') = (${t.parsed} is not null)`),
    check("verdicts_origin_check", sql`${t.origin} in ('model', 'replayed', 'fixture') and (${t.origin} = 'model') = (${t.llmCallId} is not null) and (${t.origin} = 'replayed') = (${t.replayOf} is not null)`),
  ],
);

// One paid direct-discovery attempt: the primary model, then at most one fallback after a confirmed
// refusal. The row is written before the provider is called and the provider's batch ID right after,
// so a restarted worker polls the batch it already has and never submits a second one.
export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: id(),
    analysisId: ref("analysis_id")
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(), // 1 primary, 2 fallback
    role: text("role").notNull(),
    model: text("model").notNull(), // the model asked; the answering model is on its llm_calls row and verdicts
    promptVersion: text("prompt_version").notNull(),
    effort: text("effort").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    status: text("status").notNull(),
    batchId: text("batch_id"),
    customId: text("custom_id").notNull(),
    reservationId: ref("reservation_id").references(() => budgetReservations.id),
    maxCostUsd: numeric("max_cost_usd", { precision: 14, scale: 8, mode: "number" }).notNull(),
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    stopReason: text("stop_reason"),
    refusalCategory: text("refusal_category"),
    error: text("error"),
    output: jsonb("output"), // the parsed model output, as received
    audit: jsonb("audit"), // what verification made of every proposed finding, including those with no row
    sourceHashes: jsonb("source_hashes").notNull(), // PDF SHA-256 per deposition, and the prompt's hash
    latencyMs: integer("latency_ms"), // from the provider's creation of the batch to its end
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("discovery_runs_attempt_unique").on(t.analysisId, t.attempt),
    check("discovery_runs_attempt_check", sql`${t.attempt} in (1, 2)`),
    check("discovery_runs_status_check", sql`${t.status} in ('submitting', 'submitted', 'succeeded', 'refused', 'invalid_output', 'incomplete', 'provider_failed', 'expired', 'cancelled', 'submission_unknown')`),
  ],
);

// The scored result of a valid verdict (DESIGN.md `findings`): code's evidence status and attribution
// levels, the rubric's assessment, and the review priority. A verdict whose evidence fails the gate,
// or that Claude calls insufficient_evidence, is still a finding, unscored with its reason.
export const findings = pgTable(
  "findings",
  {
    id: id(),
    caseId: ref("case_id")
      .notNull()
      .references(() => cases.id),
    candidateId: ref("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    verdictId: ref("verdict_id")
      .notNull()
      .unique()
      .references(() => verdicts.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // Claude's classification
    evidenceStatus: text("evidence_status").notNull(), // code: verified | approximate | wrong_reference | unsupported
    attributionA: text("attribution_a").notNull(), // combined level: clear | qualified | uncertain | not_adopted | no_recall
    attributionB: text("attribution_b").notNull(),
    score: integer("score"),
    band: text("band"),
    unscoredReason: text("unscored_reason"),
    factors: jsonb("factors").notNull(),
    caps: jsonb("caps").notNull(),
    checks: jsonb("checks").notNull(), // code's source, attribution, context, corroboration and time checks
    rubricVersion: text("rubric_version").notNull(),
    priority: text("priority").notNull(),
    // Claude asked for lines outside the packet. Shown on the finding; for a false positive it no
    // longer forces the needs_context priority.
    contextRequested: boolean("context_requested").notNull().default(false),
    reviewState: text("review_state").notNull().default("unreviewed"),
    createdAt: createdAt(),
  },
  (t) => [
    index("findings_case_review_idx").on(t.caseId, t.reviewState, t.priority, t.score, t.id),
    check("findings_score_check", sql`(${t.score} is null) = (${t.band} is null) and (${t.score} is null or ${t.score} between 0 and 100)`),
  ],
);

// One requested comparison of two depositions of a witness, run in the background (DESIGN.md
// "jobs", simplified): retrieval, then adjudication of the selected candidates under a budget. Its
// candidates carry its ID (candidates.job_id) in the set `analysis-<id>`. `live` calls the model and
// needs credentials and ALLOW_PAID_CALLS; `demo` never calls a model, replaying stored verdicts.
// One request to the adjudication model: one candidate or a batch. The charge lives once in llm_calls
// (null when no response came back); a candidate's share is an allocation of it, never a second charge.
export const adjudicationRequestStatus = pgEnum("adjudication_request_status", ["sent", "completed", "partial", "failed", "rate_limited", "aborted", "oversize"]);
export const adjudicationRequests = pgTable(
  "adjudication_requests",
  {
    id: id(),
    batchId: text("batch_id").notNull(),
    analysisId: ref("analysis_id"), // null for experiment runs, which name their candidate set instead
    candidateSet: text("candidate_set").notNull(),
    candidateIds: bigint("candidate_ids", { mode: "number" }).array().notNull(),
    strategy: text("strategy").notNull(),
    maxConcurrency: integer("max_concurrency").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: adjudicationRequestStatus("status").notNull().default("sent"),
    providerRequestId: text("provider_request_id"), // the API's request ID, when a response came back
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    reservationId: ref("reservation_id").references(() => budgetReservations.id),
    estimatedInputTokens: integer("estimated_input_tokens").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    maxCostUsd: numeric("max_cost_usd", { precision: 14, scale: 8, mode: "number" }).notNull(),
    latencyMs: integer("latency_ms"),
    errorKind: text("error_kind"), // rate_limited, overloaded, aborted, api_error, network, cut_off, refused, unparseable, oversize
    error: text("error"),
    retryAfterMs: integer("retry_after_ms"),
    missingCandidateIds: bigint("missing_candidate_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
    duplicateCandidateIds: bigint("duplicate_candidate_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
    unknownCandidateIds: text("unknown_candidate_ids").array().notNull().default(sql`'{}'::text[]`),
    contaminatedCandidateIds: bigint("contaminated_candidate_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
    suspectedCandidateIds: bigint("suspected_candidate_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
    splitReason: text("split_reason"), // why this batch is smaller than the strategy's size
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("adjudication_requests_set_idx").on(t.candidateSet), index("adjudication_requests_analysis_idx").on(t.analysisId)],
);

export const analysisStatus = pgEnum("analysis_status", [
  "queued",
  "parsing", // waiting for a deposition still being read
  "retrieving",
  "adjudicating",
  "completed",
  "failed",
  "blocked_budget", // stopped before a call the budget couldn't cover; completed work is kept
  "blocked_credentials", // live mode without an API key or permission for paid calls
  "cancelled", // stopped by the user; completed work is kept
  "interrupted", // its worker stopped mid-run; nothing continues until someone resumes it
]);
export const analyses = pgTable(
  "analyses",
  {
    id: id(),
    caseId: ref("case_id")
      .notNull()
      .references(() => cases.id),
    witnessId: ref("witness_id")
      .notNull()
      .references(() => witnesses.id),
    depositionA: ref("deposition_a")
      .notNull()
      .references(() => depositions.id),
    depositionB: ref("deposition_b")
      .notNull()
      .references(() => depositions.id),
    mode: text("mode").notNull(),
    promptVersion: text("prompt_version").notNull(),
    effort: text("effort").notNull(),
    maxCandidates: integer("max_candidates").notNull(),
    budgetUsd: numeric("budget_usd", { precision: 14, scale: 8, mode: "number" }).notNull(),
    budgetId: ref("budget_id").references(() => budgets.id),
    // How adjudication runs (adjudicate/strategies.ts). A is one candidate per call, one at a time.
    strategy: text("strategy").notNull().default("A"),
    // How findings were discovered: `direct_fable` (one model reads both sessions whole), or `hybrid`
    // (statement cards, topics and Path B). `pair`, the removed earlier pool, remains only on past
    // analyses, whose stored results stay readable.
    retrieval: text("retrieval").notNull().default("hybrid"),
    candidatesPerRequest: integer("candidates_per_request").notNull().default(1),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    // The worker running this analysis, and when it last said so: a second delivery of the job sees a
    // live runner and leaves; a runner gone silent means the previous worker died.
    runnerId: text("runner_id"),
    runnerSeenAt: timestamp("runner_seen_at", { withTimezone: true }),
    status: analysisStatus("status").notNull().default("queued"),
    // Counts as the stages finish: { candidates: { selected, deferred }, adjudicated, replayed,
    // fixture, withoutVerdict, failed, findings }. Never a percentage.
    progress: jsonb("progress").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("analyses_case_idx").on(t.caseId, t.id),
    check("analyses_mode_check", sql`${t.mode} in ('live', 'demo')`),
    check("analyses_pair_check", sql`${t.depositionA} <> ${t.depositionB}`),
    check("analyses_retrieval_check", sql`${t.retrieval} in ('pair', 'hybrid', 'direct_fable')`),
    check("analyses_budget_check", sql`${t.budgetUsd} >= 0 and ${t.maxCandidates} > 0`),
  ],
);

// Statement cards (DESIGN.md, "Path A"): what each exchange asserts, as a retrieval representation
// only. A card is never evidence; the source lines stay authoritative. An exchange has zero, one or
// several cards. A rejected card is kept with its reason and the model's raw text, so its structured
// fields can be null; a usable one has them all. card_key is stable across re-runs of a version.
export const cardStance = pgEnum("card_stance", CARD_STANCES);
export const cardEpistemic = pgEnum("card_epistemic", CARD_EPISTEMIC);
export const cardStatus = pgEnum("card_status", ["usable", "rejected"]);
export const statementCards = pgTable(
  "statement_cards",
  {
    id: id(),
    cardKey: text("card_key").notNull(),
    exchangeId: ref("exchange_id"), // null only for a rejected card citing a part outside its chunk
    citedExchange: text("cited_exchange").notNull(), // as the model wrote it
    depositionId: ref("deposition_id").notNull(),
    witnessId: ref("witness_id").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourcePhrase: text("source_phrase"),
    firstLineId: ref("first_line_id").references(() => lines.id),
    lastLineId: ref("last_line_id").references(() => lines.id),
    statement: text("statement"),
    event: text("event"),
    subject: text("subject"),
    entities: text("entities").array().notNull().default(sql`'{}'::text[]`),
    ungroundedEntities: text("ungrounded_entities").array().notNull().default(sql`'{}'::text[]`),
    predicate: text("predicate"),
    object: text("object"),
    time: text("time"),
    location: text("location"),
    amount: text("amount"),
    stance: cardStance("stance"),
    epistemic: cardEpistemic("epistemic"),
    status: cardStatus("status").notNull(),
    rejectionReason: text("rejection_reason"),
    raw: jsonb("raw").notNull(), // the model's card as received
    llmCallId: ref("llm_call_id")
      .notNull()
      .references(() => llmCalls.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("statement_cards_key_unique").on(t.extractorVersion, t.cardKey),
    foreignKey({ name: "statement_cards_exchange_fk", columns: [t.exchangeId, t.depositionId], foreignColumns: [exchanges.id, exchanges.depositionId] }).onDelete("cascade"),
    foreignKey({ name: "statement_cards_deposition_witness_fk", columns: [t.depositionId, t.witnessId], foreignColumns: [depositions.id, depositions.witnessId] }).onDelete("cascade"),
    index("statement_cards_witness_idx").on(t.witnessId, t.depositionId, t.status),
    index("statement_cards_exchange_idx").on(t.exchangeId),
    check("statement_cards_rejected_check", sql`(${t.status}::text = 'rejected') = (${t.rejectionReason} is not null)`),
    check(
      "statement_cards_usable_check",
      sql`${t.status}::text <> 'usable' or (${t.exchangeId} is not null and ${t.firstLineId} is not null and ${t.lastLineId} is not null and ${t.sourcePhrase} is not null and ${t.statement} is not null and ${t.event} is not null and ${t.subject} is not null and ${t.predicate} is not null and ${t.stance} is not null and ${t.epistemic} is not null)`,
    ),
  ],
);

// Whether each eligible exchange part was processed, per extractor version. An unprocessed part is
// never read as having no claims: no_assertion is the model saying so, omitted is the model's silence.
export const cardCoverageStatus = pgEnum("card_coverage_status", ["carded", "no_assertion", "omitted", "failed", "not_processed", "suspected_omission"]);
export const cardCoverage = pgTable(
  "card_coverage",
  {
    exchangeId: ref("exchange_id").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    depositionId: ref("deposition_id").notNull(),
    status: cardCoverageStatus("status").notNull(),
    cards: integer("cards").notNull().default(0), // usable cards
    error: text("error"), // why it failed
    llmCallId: ref("llm_call_id").references(() => llmCalls.id), // null when no response came back
    // Why code doubted a noAssertion, and the response that said it. Kept after a re-extraction, so a
    // recovered exchange still shows what the first response did. No status removes testimony from Path B.
    suspicionSignals: text("suspicion_signals").array().notNull().default(sql`'{}'::text[]`),
    suspectedCallId: ref("suspected_call_id").references(() => llmCalls.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "card_coverage_pk", columns: [t.exchangeId, t.extractorVersion] }),
    foreignKey({ name: "card_coverage_exchange_fk", columns: [t.exchangeId, t.depositionId], foreignColumns: [exchanges.id, exchanges.depositionId] }).onDelete("cascade"),
    index("card_coverage_deposition_idx").on(t.depositionId, t.extractorVersion, t.status),
    check("card_coverage_carded_check", sql`(${t.status}::text = 'carded') = (${t.cards} > 0)`),
    check("card_coverage_failed_check", sql`(${t.status}::text = 'failed') = (${t.error} is not null)`),
  ],
);

// A witness's topic map, one row per topic per map_version. A topic's name is a label for the lawyer,
// never evidence. Each version has one is_unassigned topic, for cards the map gave no real topic.
export const topics = pgTable(
  "topics",
  {
    id: id(),
    witnessId: ref("witness_id")
      .notNull()
      .references(() => witnesses.id, { onDelete: "cascade" }),
    mapVersion: integer("map_version").notNull(),
    name: text("name").notNull(),
    sessions: integer("sessions").notNull().default(0), // how many depositions it spans
    isUnassigned: boolean("is_unassigned").notNull().default(false),
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("topics_name_unique").on(t.witnessId, t.mapVersion, t.name),
    unique("topics_id_version_unique").on(t.id, t.mapVersion),
    uniqueIndex("topics_one_unassigned").on(t.witnessId, t.mapVersion).where(sql`${t.isUnassigned}`),
  ],
);

// Many-to-many: a card may belong to several topics, and has at most one primary per map version.
// map_version repeats the topic's, tied to it by the foreign key, so the database can enforce that.
export const cardTopics = pgTable(
  "card_topics",
  {
    topicId: ref("topic_id").notNull(),
    cardId: ref("card_id")
      .notNull()
      .references(() => statementCards.id, { onDelete: "cascade" }),
    mapVersion: integer("map_version").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    primaryKey({ name: "card_topics_pk", columns: [t.topicId, t.cardId] }),
    foreignKey({ name: "card_topics_topic_fk", columns: [t.topicId, t.mapVersion], foreignColumns: [topics.id, topics.mapVersion] }).onDelete("cascade"),
    uniqueIndex("card_topics_one_primary").on(t.cardId, t.mapVersion).where(sql`${t.isPrimary}`),
    index("card_topics_card_idx").on(t.cardId),
  ],
);

// The topics a Path A candidate was found through: one candidate, however many topics it shares.
export const candidateTopics = pgTable(
  "candidate_topics",
  {
    candidateId: ref("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    topicId: ref("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ name: "candidate_topics_pk", columns: [t.candidateId, t.topicId] }), index("candidate_topics_topic_idx").on(t.topicId)],
);
