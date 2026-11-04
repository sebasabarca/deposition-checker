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
  doublePrecision,
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
export const sourceFormat = pgEnum("source_format", ["pdf", "html", "text", "rtf", "docx"]);
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

// People who sign in. Each account has its own private workspace (an org, created with it) and
// sees only its cases. The password is stored as a salted scrypt hash, never in clear
// (server/src/auth.ts). Uploading and checking need a verified email; paid checks also need
// analysis_access, granted by an administrator until credits exist.
export const users = pgTable(
  "users",
  {
    id: id(),
    orgId: ref("org_id")
      .notNull()
      .references(() => orgs.id),
    email: text("email").notNull(), // lowercased
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }), // when the first-run tour was finished or skipped
    analysisAccess: boolean("analysis_access").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

// One-time links sent by email: verifying an address, or resetting a password. Like sessions, only
// the token's SHA-256 is stored. A token works once (used_at) and only until it expires.
export const authTokenPurpose = pgEnum("auth_token_purpose", ["verify_email", "reset_password"]);
export const authTokens = pgTable(
  "auth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: ref("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: authTokenPurpose("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("auth_tokens_user_id_idx").on(t.userId)],
);

// A signed-in browser. The cookie carries a random token; only its SHA-256 is stored, so a leaked
// database can't be replayed as a session.
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: ref("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

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

// One sitting of one witness (DESIGN.md, "Stage 1 evidence foundation"). A session can span several
// uploaded files (depositions, its parts); files are never merged into one session by witness or date,
// only by an explicit association. A database trigger gives a deposition stored without a session its
// own (so every existing insert path keeps one file per session), and removes a session left empty.
export const depositionSessions = pgTable(
  "deposition_sessions",
  {
    id: id(),
    caseId: ref("case_id")
      .notNull()
      .references(() => cases.id),
    witnessId: ref("witness_id").notNull(),
    label: text("label"), // how the user names it, e.g. "Day 2, afternoon"; optional
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "deposition_sessions_witness_case_fk", columns: [t.witnessId, t.caseId], foreignColumns: [witnesses.id, witnesses.caseId] }),
    // Target for depositions' (session, witness) foreign key: a session's files are one witness's.
    unique("deposition_sessions_id_witness_unique").on(t.id, t.witnessId),
    index("deposition_sessions_case_idx").on(t.caseId),
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
    // The session this file belongs to, and its place in it (1 for the first or only file).
    // Filled by the trigger when omitted (NOT NULL is checked after it runs).
    sessionId: ref("session_id").notNull().default(sql`NULL`),
    sessionPart: integer("session_part").notNull().default(1),
    // Kept, with every analysis and finding on it, but left out of new analyses and the case's evidence
    // index: legacy_parse (read by a parser too old to correct without losing findings) or duplicate (the
    // same file stored again in the case; duplicate_of names the copy that counts) or misfiled (another
    // witness's or case's testimony stored under this one). Null: active.
    excludedReason: text("excluded_reason"),
    duplicateOf: ref("duplicate_of").references((): AnyPgColumn => depositions.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("depositions_excluded_check", sql`(${t.excludedReason} is null or ${t.excludedReason} in ('legacy_parse', 'duplicate', 'misfiled')) and (${t.excludedReason} is not distinct from 'duplicate') = (${t.duplicateOf} is not null) and ${t.duplicateOf} is distinct from ${t.id}`),
    foreignKey({ name: "depositions_session_witness_fk", columns: [t.sessionId, t.witnessId], foreignColumns: [depositionSessions.id, depositionSessions.witnessId] }),
    unique("depositions_session_part_unique").on(t.sessionId, t.sessionPart),
    check("depositions_session_part_check", sql`${t.sessionPart} >= 1`),
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

// Speaker changes inside one stored line (ingest/segments.ts): an archive statement that runs two
// turns together, "Q: … drove up in? A.Yes, I do.". Each segment is a character range of the line's
// raw_text, which stays untouched, with the speaker its label names; the line keeps its own reference.
// Only lines with more than one segment have rows. Added in parser revision 9.
export const lineSegments = pgTable(
  "line_segments",
  {
    lineId: ref("line_id").notNull(),
    depositionId: ref("deposition_id").notNull(),
    seq: integer("seq").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    speakerRole: speakerRole("speaker_role").notNull(),
    speakerName: text("speaker_name"),
  },
  (t) => [
    primaryKey({ name: "line_segments_pk", columns: [t.lineId, t.seq] }),
    foreignKey({ name: "line_segments_line_fk", columns: [t.lineId, t.depositionId], foreignColumns: [lines.id, lines.depositionId] }).onDelete("cascade"),
    index("line_segments_deposition_idx").on(t.depositionId),
    check("line_segments_range_check", sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`),
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
    // Stage 1 evidence fields (server/src/evidence/exchange.ts). Null until indexed: set at ingestion,
    // and by `scripts/evidence.ts index` for exchanges stored before them, so a missing one is reported.
    // evidence_key: stable across re-ingestion of the same file (from its SHA-256 and the exchange's
    // first and last page:line); text_hash: of its stored source lines; speaker_status: verified,
    // uncertain or invalid, from the line roles alone.
    evidenceKey: text("evidence_key"),
    textHash: text("text_hash"),
    speakerStatus: text("speaker_status"),
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
    unique("exchanges_evidence_key_unique").on(t.depositionId, t.evidenceKey),
    index("exchanges_evidence_key_idx").on(t.evidenceKey),
    check("exchanges_speaker_status_check", sql`${t.speakerStatus} is null or ${t.speakerStatus} in ('verified', 'uncertain', 'invalid')`),
    check("exchanges_evidence_fields_check", sql`(${t.evidenceKey} is null) = (${t.textHash} is null) and (${t.evidenceKey} is null) = (${t.speakerStatus} is null)`),
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
    // A line holding several turns (line_segments) can belong to two exchanges: "A: Yes. Q. Where?" ends
    // one and starts the next. These are the seq range (inclusive) of its segments that belong to this
    // exchange; null means all of them (or a line without segments). Added in parser revision 10.
    segmentFrom: integer("segment_from"),
    segmentTo: integer("segment_to"),
  },
  (t) => [
    check("exchange_lines_segments_check", sql`(${t.segmentFrom} is null) = (${t.segmentTo} is null) and (${t.segmentFrom} is null or ${t.segmentFrom} between 0 and ${t.segmentTo})`),
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

export const llmStage = pgEnum("llm_stage", ["claim_tagging", "adjudication", "statement_cards", "topic_mapping", "discovery", "fact_extraction"]);

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
// deferred (with deferred_reason), excluded (with exclusion_reason), audit, uncovered (retrieved but in no
// issue packet, with deferred_reason giving why; never read, never compatible).
export const candidateStatus = pgEnum("candidate_status", ["selected", "deferred", "audit", "adjudicated", "excluded", "uncovered"]);
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
    // Not unique: a candidate can hold several verdicts (replays, earlier analyses of the same set).
    index("verdicts_candidate_idx").on(t.candidateId),
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
    reviewState: text("review_state").notNull().default("unreviewed"), // a person's decision: unreviewed | confirmed | needs_context | dismissed
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
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
    // A case-run request sent through the Message Batches API (economy mode): its provider batch, its custom_id
    // (unique, so a result delivered twice is imported once), its ledger entry, its round (1 the packet, 2 the
    // recovery request) and the request it retries (an unbilled errored or expired one, retried once).
    caseRunBatchId: ref("case_run_batch_id").references(() => caseRunBatches.id),
    customId: text("custom_id"),
    screeningEntryId: ref("screening_entry_id").references(() => screeningEntries.id),
    round: integer("round"),
    retryOf: ref("retry_of"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("adjudication_requests_set_idx").on(t.candidateSet),
    index("adjudication_requests_analysis_idx").on(t.analysisId),
    uniqueIndex("adjudication_requests_custom_id_unique").on(t.customId),
    index("adjudication_requests_batch_idx").on(t.caseRunBatchId),
    index("adjudication_requests_entry_idx").on(t.screeningEntryId),
  ],
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
    // same_witness: two sessions of one witness. cross_witness: one session of witness A (witnessId,
    // depositionA) against one of witness B (witnessBId, depositionB). Cross-witness runs only by direct discovery.
    kind: text("kind").notNull().default("same_witness"),
    witnessBId: ref("witness_b_id").references(() => witnesses.id),
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
    check("analyses_kind_check", sql`${t.kind} in ('same_witness', 'cross_witness') and (${t.kind} = 'cross_witness') = (${t.witnessBId} is not null) and (${t.kind} = 'same_witness' or (${t.retrieval} = 'direct_fable' and ${t.witnessBId} <> ${t.witnessId}))`),
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

// Stage 2: source-grounded facts (server/src/claims/facts). A unit is one logical answer group (every
// part of an exchange group, overlap read once), or a window of one too long for a single request. Each
// unit has one row per extractor version from the start, so coverage counts what was never processed:
// pending until a response says otherwise. source_hash is of the unit's own source spans (text, speaker,
// role); a change makes its facts stale, never silently current.
export const factUnits = pgTable(
  "fact_units",
  {
    unitKey: text("unit_key").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    caseId: ref("case_id").notNull(),
    witnessId: ref("witness_id").notNull(),
    depositionId: ref("deposition_id")
      .notNull()
      .references(() => depositions.id, { onDelete: "cascade" }),
    groupId: integer("group_id").notNull(),
    windowNo: integer("window_no").notNull(), // 1-based; window_count > 1 only for an oversized answer group
    windowCount: integer("window_count").notNull(),
    exchangeIds: bigint("exchange_ids", { mode: "number" }).array().notNull(),
    sourceHash: text("source_hash").notNull(),
    parserVersion: text("parser_version").notNull(),
    status: text("status").notNull().default("pending"),
    facts: integer("facts").notNull().default(0), // indexed facts from this unit
    rejected: integer("rejected").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0), // facts already found in an overlapping window
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "fact_units_pk", columns: [t.unitKey, t.extractorVersion] }),
    index("fact_units_deposition_idx").on(t.depositionId, t.extractorVersion),
    // suspected_omission: the model returned no facts for an answer that looks substantive or speaks of memory
    // (added with fact-schema-v2); kept apart from empty so it is never read as "nothing to extract".
    check("fact_units_status_check", sql`${t.status} in ('pending', 'extracted', 'empty', 'suspected_omission', 'no_testimony', 'omitted', 'failed', 'incomplete')`),
  ],
);

// One fact the model proposed, as code checked it. Only status 'indexed' is in the verified index: its
// evidence phrase was found in the cited source spans and its attribution isn't invalid. Rejected facts
// are kept for diagnosis; stale ones came from source spans that have changed since.
export const facts = pgTable(
  "facts",
  {
    id: id(),
    factKey: text("fact_key").notNull().unique(), // stable for the same unit, version and content: a retry can't duplicate it
    unitKey: text("unit_key").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    caseId: ref("case_id").notNull(),
    witnessId: ref("witness_id").notNull(),
    depositionId: ref("deposition_id")
      .notNull()
      .references(() => depositions.id, { onDelete: "cascade" }),
    exchangeId: ref("exchange_id"), // the exchange part holding its first cited span; null when no span resolved
    sourceSpanIds: text("source_span_ids").array().notNull(), // Stage 1 source IDs, with "#<seq>" for a segment
    lineIds: bigint("line_ids", { mode: "number" }).array().notNull(),
    kind: text("kind"), // action | attribute | memory_or_knowledge (fact-schema-v2)
    subject: text("subject"),
    entities: text("entities").array().notNull().default(sql`'{}'::text[]`),
    predicate: text("predicate"),
    attribute: text("attribute"), // the property described, without its value
    object: text("object"), // the asserted value
    valuePhrase: text("value_phrase"), // the cited words stating the value
    contextSpanIds: text("context_span_ids").array().notNull().default(sql`'{}'::text[]`), // earlier lines the reading depends on
    factualQuestion: text("factual_question"),
    factualDimension: text("factual_dimension"),
    polarity: text("polarity"),
    epistemicStatus: text("epistemic_status"),
    reportedSpeaker: text("reported_speaker"),
    hedges: text("hedges").array().notNull().default(sql`'{}'::text[]`),
    timeContext: text("time_context"),
    locationContext: text("location_context"),
    event: jsonb("event"), // provisional: description, type, participants, date, location; never an event ID
    eventHints: text("event_hints").array().notNull().default(sql`'{}'::text[]`),
    evidencePhrase: text("evidence_phrase"),
    provenance: text("provenance"), // witness_statement | question_adopted
    attributionStatus: text("attribution_status").notNull(), // verified | uncertain | invalid
    sourceVerification: text("source_verification").notNull(), // verified | approximate | unsupported | invalid_reference
    valueSupport: text("value_support"), // verified | approximate | not_applicable (fact-schema-v2)
    // source_supported: the value is the cited words and nothing needs a reader; needs_semantic_review
    // otherwise, with review_reasons. Never "verified": code checks quotations, not interpretation.
    semanticStatus: text("semantic_status"),
    reviewReasons: text("review_reasons").array().notNull().default(sql`'{}'::text[]`),
    correction: boolean("correction"),
    status: text("status").notNull(), // indexed | rejected | stale
    rejectionReason: text("rejection_reason"),
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
    sourceHash: text("source_hash").notNull(),
    raw: jsonb("raw").notNull(), // the model's fact as received
    llmCallId: ref("llm_call_id").references(() => llmCalls.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "facts_exchange_fk", columns: [t.exchangeId, t.depositionId], foreignColumns: [exchanges.id, exchanges.depositionId] }).onDelete("cascade"),
    index("facts_case_dimension_idx").on(t.caseId, t.factualDimension),
    index("facts_unit_idx").on(t.unitKey, t.extractorVersion),
    check("facts_status_check", sql`${t.status} in ('indexed', 'rejected', 'stale')`),
    check("facts_indexed_check", sql`${t.status} <> 'indexed' or (${t.sourceVerification} in ('verified', 'approximate') and ${t.attributionStatus} <> 'invalid' and ${t.rejectionReason} is null and ${t.factualDimension} is not null and ${t.evidencePhrase} is not null)`),
  ],
);

// A whole-case analysis (jobs/caseRun.ts): every witness and session of a case, retrieved with the offline
// multi-path system, packeted, and adjudicated packet by packet through the screening ledger, with screening
// off (every packet prioritized). Kept apart from `analyses`, whose rows are one pair of depositions.
// mode: live calls the packet model; mock uses the deterministic label-blind mock and is never billed.
export const caseRuns = pgTable(
  "case_runs",
  {
    id: id(),
    caseId: ref("case_id")
      .notNull()
      .references(() => cases.id),
    status: text("status").notNull().default("queued"),
    mode: text("mode").notNull(),
    // standard: Messages API requests in parallel (fast). batch: the Message Batches API (economy, half price,
    // up to 24 hours). Chosen at confirmation and fixed once model processing starts.
    execution: text("execution").notNull().default("standard"),
    // Economy only: when the person acknowledged that the provider stores batch inputs and results for 29 days.
    retentionAcknowledgedAt: timestamp("retention_acknowledged_at", { withTimezone: true }),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    budgetUsd: numeric("budget_usd", { precision: 14, scale: 8, mode: "number" }).notNull(),
    budgetId: ref("budget_id").references(() => budgets.id),
    config: jsonb("config").notNull(), // retrieval, triage and grouping settings, verifier and rubric versions
    sourceHash: text("source_hash"), // the case's evidence when retrieval ran
    progress: jsonb("progress").notNull().default(sql`'{}'::jsonb`), // counts, never a percentage
    error: text("error"),
    runnerId: text("runner_id"),
    runnerSeenAt: timestamp("runner_seen_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    // A live run stops after retrieval (awaiting_confirmation, with its estimate in progress) until someone
    // confirms it with a budget; only then can it send a paid request. Mock runs need no confirmation.
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("case_runs_case_idx").on(t.caseId, t.id),
    check("case_runs_mode_check", sql`${t.mode} in ('live', 'mock')`),
    check("case_runs_budget_check", sql`${t.budgetUsd} >= 0`),
    check(
      "case_runs_status_check",
      sql`${t.status} in ('queued', 'retrieving', 'awaiting_confirmation', 'adjudicating', 'completed', 'incomplete', 'failed', 'blocked_budget', 'blocked_credentials', 'cancelled', 'interrupted')`,
    ),
    check("case_runs_execution_check", sql`${t.execution} in ('standard', 'batch')`),
  ],
);

// One provider batch of an economy case run (jobs/caseRunBatch.ts). The row and its requests are written before
// the provider is called (`submitting`), the provider's ID right after (`submitted`). A row left `submitting`
// by a crash is reconciled from the provider's batch list, and never sent again blindly (`submission_unknown`
// until someone decides). The requests are adjudication_requests rows; their usage and cost are llm_calls rows.
//   submitting -> submitted -> (canceling) -> ended -> imported
//   submitting -> not_submitted (the provider refused it: nothing billed) | submission_unknown
export const caseRunBatches = pgTable(
  "case_run_batches",
  {
    id: id(),
    caseRunId: ref("case_run_id")
      .notNull()
      .references(() => caseRuns.id),
    seq: integer("seq").notNull(),
    status: text("status").notNull().default("submitting"),
    providerBatchId: text("provider_batch_id"),
    requestCount: integer("request_count").notNull(),
    payloadBytes: integer("payload_bytes").notNull(),
    maxCostUsd: numeric("max_cost_usd", { precision: 14, scale: 8, mode: "number" }).notNull(), // the sum of its reservations
    providerStatus: text("provider_status"), // in_progress, canceling, ended
    requestCounts: jsonb("request_counts"), // the provider's counts: processing, succeeded, errored, canceled, expired
    resultsImported: integer("results_imported").notNull().default(0),
    error: text("error"),
    recovery: text("recovery"), // how a crash during submission was resolved
    createdAt: createdAt(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("case_run_batches_seq_unique").on(t.caseRunId, t.seq),
    uniqueIndex("case_run_batches_provider_unique").on(t.providerBatchId),
    check("case_run_batches_status_check", sql`${t.status} in ('submitting', 'submitted', 'canceling', 'ended', 'imported', 'not_submitted', 'submission_unknown')`),
  ],
);

// Evidence screening ledger (Milestone 3, experimental; server/src/screen/ledger.ts). A screening run orders a
// packet set's issue packets for adjudication; each entry keeps its packet's original items and pairs, and its
// adjudication progress apart from its screening status. Deferred means unread, never compatible. Entries are
// never deleted, and the packet set's uncovered pairs are kept on the run with their reasons.
export const screeningRuns = pgTable("screening_runs", {
  id: id(),
  corpus: text("corpus").notNull(),
  packetSetName: text("packet_set_name").notNull(),
  packetSetSha256: text("packet_set_sha256").notNull(),
  poolSha256: text("pool_sha256").notNull(),
  itemsSha256: text("items_sha256").notNull(),
  strategy: text("strategy").notNull(),
  strategyVersion: text("strategy_version").notNull(),
  contract: text("contract").notNull(), // SCREENING_CONTRACT_VERSION
  budget: integer("budget").notNull(), // packets prioritized
  settings: jsonb("settings").notNull(),
  poolPairs: integer("pool_pairs").notNull(),
  uncovered: jsonb("uncovered").$type<{ a: string; b: string; reason: string }[]>().notNull(),
  // Set when the run belongs to a whole-case run (jobs/caseRun.ts); null on offline benchmark runs.
  caseId: ref("case_id").references(() => cases.id),
  caseRunId: ref("case_run_id").references(() => caseRuns.id),
  sourceHash: text("source_hash"), // the case's stored evidence when the run was built
  createdAt: createdAt(),
});

export const screeningEntries = pgTable(
  "screening_entries",
  {
    id: id(),
    runId: ref("run_id")
      .notNull()
      .references(() => screeningRuns.id, { onDelete: "restrict" }),
    packetId: text("packet_id").notNull(),
    rank: integer("rank"), // null only when consolidated
    screenStatus: text("screen_status").notNull(), // prioritized | deferred | consolidated
    consolidatedInto: text("consolidated_into"),
    reason: text("reason").notNull(),
    priority: doublePrecision("priority").notNull(), // an ordering key, never a probability
    signals: jsonb("signals").$type<Record<string, number | boolean>>().notNull(),
    sessions: jsonb("sessions").$type<string[]>().notNull(),
    witnesses: jsonb("witnesses").$type<string[]>().notNull(),
    items: jsonb("items").$type<{ key: string; sourceHash: string; session: string; witness: string }[]>().notNull(),
    pairs: jsonb("pairs").$type<[string, string][]>().notNull(),
    adjudicationStatus: text("adjudication_status").notNull().default("not_started"),
    adjudicationRef: text("adjudication_ref"),
    adjudicationNote: text("adjudication_note"),
    // Database identifiers, on entries of a whole-case run: the candidates (one per pair, in `pairs` order),
    // and the exchanges, depositions and sessions the packet reads.
    candidateIds: bigint("candidate_ids", { mode: "number" }).array(),
    exchangeIds: bigint("exchange_ids", { mode: "number" }).array(),
    documentIds: bigint("document_ids", { mode: "number" }).array(),
    sessionIds: bigint("session_ids", { mode: "number" }).array(),
    attempts: integer("attempts").notNull().default(0), // model calls made for this packet, recovery included
    requestId: ref("request_id"), // the last adjudication_requests row
    llmCallId: ref("llm_call_id"), // the stored reply: reused on resume instead of a second paid call
    failureBillable: boolean("failure_billable"), // on failure: whether the failed call may have been charged
    unresolvedPairs: jsonb("unresolved_pairs").$type<{ a: string; b: string; status: string }[]>(), // incomplete: pairs left without a verdict
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("screening_entries_run_packet_unique").on(t.runId, t.packetId),
    index("screening_entries_queue_idx").on(t.runId, t.adjudicationStatus, t.rank),
    check("screening_entries_screen_status_check", sql`${t.screenStatus} in ('prioritized', 'deferred', 'consolidated')`),
    check("screening_entries_adjudication_status_check", sql`${t.adjudicationStatus} in ('not_started', 'in_progress', 'adjudicated', 'incomplete', 'failed')`),
    check("screening_entries_consolidated_check", sql`(${t.screenStatus} = 'consolidated') = (${t.consolidatedInto} is not null) and (${t.screenStatus} = 'consolidated') = (${t.rank} is null)`),
  ],
);
