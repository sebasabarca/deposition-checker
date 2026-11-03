ALTER TYPE "public"."llm_stage" ADD VALUE 'fact_extraction';--> statement-breakpoint
CREATE TABLE "fact_units" (
	"unit_key" text NOT NULL,
	"extractor_version" text NOT NULL,
	"case_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"deposition_id" bigint NOT NULL,
	"group_id" integer NOT NULL,
	"window_no" integer NOT NULL,
	"window_count" integer NOT NULL,
	"exchange_ids" bigint[] NOT NULL,
	"source_hash" text NOT NULL,
	"parser_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"facts" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"llm_call_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_units_pk" PRIMARY KEY("unit_key","extractor_version"),
	CONSTRAINT "fact_units_status_check" CHECK ("fact_units"."status" in ('pending', 'extracted', 'empty', 'no_testimony', 'omitted', 'failed', 'incomplete'))
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "facts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"fact_key" text NOT NULL,
	"unit_key" text NOT NULL,
	"extractor_version" text NOT NULL,
	"case_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"deposition_id" bigint NOT NULL,
	"exchange_id" bigint,
	"source_span_ids" text[] NOT NULL,
	"line_ids" bigint[] NOT NULL,
	"subject" text,
	"predicate" text,
	"object" text,
	"factual_question" text,
	"factual_dimension" text,
	"polarity" text,
	"epistemic_status" text,
	"reported_speaker" text,
	"hedges" text[] DEFAULT '{}'::text[] NOT NULL,
	"time_context" text,
	"location_context" text,
	"event" jsonb,
	"event_hints" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_phrase" text,
	"provenance" text,
	"attribution_status" text NOT NULL,
	"source_verification" text NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_hash" text NOT NULL,
	"raw" jsonb NOT NULL,
	"llm_call_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_fact_key_unique" UNIQUE("fact_key"),
	CONSTRAINT "facts_status_check" CHECK ("facts"."status" in ('indexed', 'rejected', 'stale')),
	CONSTRAINT "facts_indexed_check" CHECK ("facts"."status" <> 'indexed' or ("facts"."source_verification" in ('verified', 'approximate') and "facts"."attribution_status" <> 'invalid' and "facts"."rejection_reason" is null and "facts"."factual_dimension" is not null and "facts"."evidence_phrase" is not null))
);
--> statement-breakpoint
ALTER TABLE "fact_units" ADD CONSTRAINT "fact_units_deposition_id_depositions_id_fk" FOREIGN KEY ("deposition_id") REFERENCES "public"."depositions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_units" ADD CONSTRAINT "fact_units_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_deposition_id_depositions_id_fk" FOREIGN KEY ("deposition_id") REFERENCES "public"."depositions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_exchange_fk" FOREIGN KEY ("exchange_id","deposition_id") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_units_deposition_idx" ON "fact_units" USING btree ("deposition_id","extractor_version");--> statement-breakpoint
CREATE INDEX "facts_case_dimension_idx" ON "facts" USING btree ("case_id","factual_dimension");--> statement-breakpoint
CREATE INDEX "facts_unit_idx" ON "facts" USING btree ("unit_key","extractor_version");