CREATE TYPE "public"."card_coverage_status" AS ENUM('carded', 'no_assertion', 'omitted', 'failed', 'not_processed');--> statement-breakpoint
CREATE TYPE "public"."card_epistemic" AS ENUM('asserted', 'qualified', 'does_not_know', 'does_not_recall', 'hypothetical', 'reported_by_other');--> statement-breakpoint
CREATE TYPE "public"."card_stance" AS ENUM('asserts', 'denies', 'not_answered', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."card_status" AS ENUM('usable', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."candidate_status" ADD VALUE 'excluded';--> statement-breakpoint
ALTER TYPE "public"."llm_stage" ADD VALUE 'statement_cards';--> statement-breakpoint
ALTER TYPE "public"."llm_stage" ADD VALUE 'topic_mapping';--> statement-breakpoint
CREATE TABLE "candidate_topics" (
	"candidate_id" bigint NOT NULL,
	"topic_id" bigint NOT NULL,
	CONSTRAINT "candidate_topics_pk" PRIMARY KEY("candidate_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "card_coverage" (
	"exchange_id" bigint NOT NULL,
	"extractor_version" text NOT NULL,
	"deposition_id" bigint NOT NULL,
	"status" "card_coverage_status" NOT NULL,
	"cards" integer DEFAULT 0 NOT NULL,
	"error" text,
	"llm_call_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_coverage_pk" PRIMARY KEY("exchange_id","extractor_version"),
	CONSTRAINT "card_coverage_carded_check" CHECK (("card_coverage"."status"::text = 'carded') = ("card_coverage"."cards" > 0)),
	CONSTRAINT "card_coverage_failed_check" CHECK (("card_coverage"."status"::text = 'failed') = ("card_coverage"."error" is not null))
);
--> statement-breakpoint
CREATE TABLE "card_topics" (
	"topic_id" bigint NOT NULL,
	"card_id" bigint NOT NULL,
	"map_version" integer NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "card_topics_pk" PRIMARY KEY("topic_id","card_id")
);
--> statement-breakpoint
CREATE TABLE "statement_cards" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "statement_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"card_key" text NOT NULL,
	"exchange_id" bigint,
	"cited_exchange" text NOT NULL,
	"deposition_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"extractor_version" text NOT NULL,
	"ordinal" integer NOT NULL,
	"source_phrase" text,
	"first_line_id" bigint,
	"last_line_id" bigint,
	"statement" text,
	"event" text,
	"subject" text,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"ungrounded_entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"predicate" text,
	"object" text,
	"time" text,
	"location" text,
	"amount" text,
	"stance" "card_stance",
	"epistemic" "card_epistemic",
	"status" "card_status" NOT NULL,
	"rejection_reason" text,
	"raw" jsonb NOT NULL,
	"llm_call_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_cards_key_unique" UNIQUE("extractor_version","card_key"),
	CONSTRAINT "statement_cards_rejected_check" CHECK (("statement_cards"."status"::text = 'rejected') = ("statement_cards"."rejection_reason" is not null)),
	CONSTRAINT "statement_cards_usable_check" CHECK ("statement_cards"."status"::text <> 'usable' or ("statement_cards"."exchange_id" is not null and "statement_cards"."first_line_id" is not null and "statement_cards"."last_line_id" is not null and "statement_cards"."source_phrase" is not null and "statement_cards"."statement" is not null and "statement_cards"."event" is not null and "statement_cards"."subject" is not null and "statement_cards"."predicate" is not null and "statement_cards"."stance" is not null and "statement_cards"."epistemic" is not null))
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "topics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"witness_id" bigint NOT NULL,
	"map_version" integer NOT NULL,
	"name" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"is_unassigned" boolean DEFAULT false NOT NULL,
	"llm_call_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_name_unique" UNIQUE("witness_id","map_version","name"),
	CONSTRAINT "topics_id_version_unique" UNIQUE("id","map_version")
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "rank_topics" integer;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "exclusion_reason" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "retrieval_version" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "map_version" integer;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "selected_by" text;--> statement-breakpoint
ALTER TABLE "candidate_topics" ADD CONSTRAINT "candidate_topics_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_topics" ADD CONSTRAINT "candidate_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_coverage" ADD CONSTRAINT "card_coverage_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_coverage" ADD CONSTRAINT "card_coverage_exchange_fk" FOREIGN KEY ("exchange_id","deposition_id") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_topics" ADD CONSTRAINT "card_topics_card_id_statement_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."statement_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_topics" ADD CONSTRAINT "card_topics_topic_fk" FOREIGN KEY ("topic_id","map_version") REFERENCES "public"."topics"("id","map_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_cards" ADD CONSTRAINT "statement_cards_first_line_id_lines_id_fk" FOREIGN KEY ("first_line_id") REFERENCES "public"."lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_cards" ADD CONSTRAINT "statement_cards_last_line_id_lines_id_fk" FOREIGN KEY ("last_line_id") REFERENCES "public"."lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_cards" ADD CONSTRAINT "statement_cards_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_cards" ADD CONSTRAINT "statement_cards_exchange_fk" FOREIGN KEY ("exchange_id","deposition_id") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_cards" ADD CONSTRAINT "statement_cards_deposition_witness_fk" FOREIGN KEY ("deposition_id","witness_id") REFERENCES "public"."depositions"("id","witness_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_witness_id_witnesses_id_fk" FOREIGN KEY ("witness_id") REFERENCES "public"."witnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_topics_topic_idx" ON "candidate_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "card_coverage_deposition_idx" ON "card_coverage" USING btree ("deposition_id","extractor_version","status");--> statement-breakpoint
CREATE UNIQUE INDEX "card_topics_one_primary" ON "card_topics" USING btree ("card_id","map_version") WHERE "card_topics"."is_primary";--> statement-breakpoint
CREATE INDEX "card_topics_card_idx" ON "card_topics" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "statement_cards_witness_idx" ON "statement_cards" USING btree ("witness_id","deposition_id","status");--> statement-breakpoint
CREATE INDEX "statement_cards_exchange_idx" ON "statement_cards" USING btree ("exchange_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_one_unassigned" ON "topics" USING btree ("witness_id","map_version") WHERE "topics"."is_unassigned";--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_excluded_check" CHECK (("candidates"."status"::text = 'excluded') = ("candidates"."exclusion_reason" is not null));--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_selected_by_check" CHECK ("candidates"."selected_by" is null or "candidates"."selected_by" in ('path_a', 'path_b'));