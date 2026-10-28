CREATE TYPE "public"."deposition_status" AS ENUM('processing', 'ready', 'needs_review', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."exchange_kind" AS ENUM('qa', 'colloquy', 'objection', 'exhibit');--> statement-breakpoint
CREATE TYPE "public"."line_role" AS ENUM('question', 'answer', 'context', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."source_format" AS ENUM('pdf', 'html');--> statement-breakpoint
CREATE TYPE "public"."speaker_role" AS ENUM('attorney', 'witness', 'colloquy', 'parenthetical', 'unknown');--> statement-breakpoint
CREATE TABLE "cases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" bigint NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depositions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "depositions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"taken_on" date,
	"file_sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"source_format" "source_format" DEFAULT 'pdf' NOT NULL,
	"page_count" integer NOT NULL,
	"needs_ocr_pages" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"blank_pages" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"validation" jsonb NOT NULL,
	"parser_version" text NOT NULL,
	"status" "deposition_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "depositions_file_unique" UNIQUE("case_id","file_sha256","parser_version"),
	CONSTRAINT "depositions_file_sha256_check" CHECK ("depositions"."file_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "exchange_lines" (
	"exchange_id" bigint NOT NULL,
	"line_id" bigint NOT NULL,
	"deposition_id" bigint NOT NULL,
	"role" "line_role" NOT NULL,
	CONSTRAINT "exchange_lines_pk" PRIMARY KEY("exchange_id","line_id")
);
--> statement-breakpoint
CREATE TABLE "exchanges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "exchanges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"deposition_id" bigint NOT NULL,
	"group_id" integer NOT NULL,
	"part_no" integer NOT NULL,
	"part_count" integer NOT NULL,
	"kind" "exchange_kind" NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_line_id" bigint NOT NULL,
	"last_line_id" bigint NOT NULL,
	"question_first_line_id" bigint,
	"question_last_line_id" bigint,
	"answer_first_line_id" bigint,
	"answer_last_line_id" bigint,
	"answer_line_count" integer NOT NULL,
	"question_text" text NOT NULL,
	"answer_text" text NOT NULL,
	"dialogue_text" text NOT NULL,
	CONSTRAINT "exchanges_part_unique" UNIQUE("deposition_id","group_id","part_no"),
	CONSTRAINT "exchanges_id_deposition_unique" UNIQUE("id","deposition_id"),
	CONSTRAINT "exchanges_part_no_check" CHECK ("exchanges"."part_no" between 1 and "exchanges"."part_count"),
	CONSTRAINT "exchanges_question_range_check" CHECK (("exchanges"."question_first_line_id" is null) = ("exchanges"."question_last_line_id" is null)),
	CONSTRAINT "exchanges_answer_range_check" CHECK (("exchanges"."answer_first_line_id" is null) = ("exchanges"."answer_last_line_id" is null)),
	CONSTRAINT "exchanges_answer_line_count_check" CHECK ("exchanges"."answer_line_count" between 0 and 40)
);
--> statement-breakpoint
CREATE TABLE "lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"deposition_id" bigint NOT NULL,
	"pdf_page" integer NOT NULL,
	"printed_page" integer NOT NULL,
	"line_no" integer NOT NULL,
	"speaker_role" "speaker_role" NOT NULL,
	"speaker_name" text,
	"raw_text" text NOT NULL,
	"norm_text" text NOT NULL,
	CONSTRAINT "lines_page_line_unique" UNIQUE("deposition_id","printed_page","line_no"),
	CONSTRAINT "lines_id_deposition_unique" UNIQUE("id","deposition_id"),
	CONSTRAINT "lines_line_no_check" CHECK ("lines"."line_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orgs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "witnesses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "witnesses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "witnesses_case_name_unique" UNIQUE("case_id","name"),
	CONSTRAINT "witnesses_id_case_unique" UNIQUE("id","case_id")
);
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_witness_case_fk" FOREIGN KEY ("witness_id","case_id") REFERENCES "public"."witnesses"("id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_lines" ADD CONSTRAINT "exchange_lines_exchange_fk" FOREIGN KEY ("exchange_id","deposition_id") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_lines" ADD CONSTRAINT "exchange_lines_line_fk" FOREIGN KEY ("line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_deposition_id_depositions_id_fk" FOREIGN KEY ("deposition_id") REFERENCES "public"."depositions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_first_line_fk" FOREIGN KEY ("first_line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_last_line_fk" FOREIGN KEY ("last_line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_question_first_line_fk" FOREIGN KEY ("question_first_line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_question_last_line_fk" FOREIGN KEY ("question_last_line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_answer_first_line_fk" FOREIGN KEY ("answer_first_line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_answer_last_line_fk" FOREIGN KEY ("answer_last_line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_deposition_id_depositions_id_fk" FOREIGN KEY ("deposition_id") REFERENCES "public"."depositions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_org_id_idx" ON "cases" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "depositions_witness_id_idx" ON "depositions" USING btree ("witness_id");--> statement-breakpoint
CREATE INDEX "exchange_lines_line_id_idx" ON "exchange_lines" USING btree ("line_id");