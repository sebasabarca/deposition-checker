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
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { Validation } from "../ingest/validate";

export const depositionStatus = pgEnum("deposition_status", [
  "processing",
  "ready",
  "needs_review",
  "unsupported",
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
    sourceFormat: sourceFormat("source_format").notNull().default("pdf"),
    pageCount: integer("page_count").notNull(),
    needsOcrPages: integer("needs_ocr_pages")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    blankPages: integer("blank_pages")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    validation: jsonb("validation").$type<Validation>().notNull(), // per-page statuses and failure reasons
    parserVersion: text("parser_version").notNull(),
    status: depositionStatus("status").notNull(),
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
    check(
      "depositions_file_sha256_check",
      sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`,
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
    normText: text("norm_text").notNull(), // lowercased, punctuation removed; for matching only
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
  },
  (t) => [
    unique("exchanges_part_unique").on(t.depositionId, t.groupId, t.partNo),
    // Target for exchange_lines' (exchange, deposition) foreign key.
    unique("exchanges_id_deposition_unique").on(t.id, t.depositionId),
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
