CREATE TYPE "public"."claim_epistemic" AS ENUM('asserted', 'qualified', 'does_not_recall', 'hypothetical', 'reported_by_other');--> statement-breakpoint
CREATE TYPE "public"."claim_polarity" AS ENUM('affirms', 'denies');--> statement-breakpoint
CREATE TYPE "public"."claim_predicate" AS ENUM('approve', 'decide', 'agree', 'know', 'communicate', 'attend', 'review', 'buy', 'sell', 'price', 'compete', 'plan', 'own', 'role', 'support', 'measure', 'other');--> statement-breakpoint
CREATE TYPE "public"."claim_source" AS ENUM('answer', 'adopted_question');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('verified', 'approximate', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."tagging_status" AS ENUM('tagged', 'failed', 'refused');--> statement-breakpoint
CREATE TABLE "claim_tagging" (
	"exchange_id" bigint NOT NULL,
	"extractor_version" text NOT NULL,
	"deposition_id" bigint NOT NULL,
	"status" "tagging_status" NOT NULL,
	"claims" integer DEFAULT 0 NOT NULL,
	"error" text,
	"llm_call_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_tagging_pk" PRIMARY KEY("exchange_id","extractor_version"),
	CONSTRAINT "claim_tagging_error_check" CHECK (("claim_tagging"."status"::text = 'tagged') = ("claim_tagging"."error" is null))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "claims_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"exchange_id" bigint,
	"cited_exchange" text NOT NULL,
	"deposition_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"extractor_version" text NOT NULL,
	"ordinal" integer NOT NULL,
	"source" "claim_source" NOT NULL,
	"key_phrase" text NOT NULL,
	"answer_phrase" text,
	"subject" text NOT NULL,
	"predicate" "claim_predicate" NOT NULL,
	"object" text,
	"polarity" "claim_polarity" NOT NULL,
	"epistemic" "claim_epistemic" NOT NULL,
	"time" text,
	"place" text,
	"quantity" text,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "claim_status" NOT NULL,
	"rejection_reason" text,
	"match_score" real NOT NULL,
	"answer_match_score" real,
	"evidence_line_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"llm_call_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_response_unique" UNIQUE("llm_call_id","cited_exchange","ordinal"),
	CONSTRAINT "claims_rejected_check" CHECK (("claims"."status"::text = 'rejected') = ("claims"."rejection_reason" is not null)),
	CONSTRAINT "claims_exchange_check" CHECK ("claims"."exchange_id" is not null or "claims"."status"::text = 'rejected'),
	CONSTRAINT "claims_answer_phrase_check" CHECK (("claims"."source"::text = 'adopted_question') = ("claims"."answer_phrase" is not null))
);
--> statement-breakpoint
ALTER TABLE "claim_tagging" ADD CONSTRAINT "claim_tagging_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_tagging" ADD CONSTRAINT "claim_tagging_exchange_fk" FOREIGN KEY ("exchange_id","deposition_id") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_exchange_fk" FOREIGN KEY ("exchange_id","deposition_id") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_deposition_witness_fk" FOREIGN KEY ("deposition_id","witness_id") REFERENCES "public"."depositions"("id","witness_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_tagging_deposition_idx" ON "claim_tagging" USING btree ("deposition_id","extractor_version");--> statement-breakpoint
CREATE INDEX "claims_witness_predicate_idx" ON "claims" USING btree ("witness_id","predicate");--> statement-breakpoint
CREATE INDEX "claims_entities_idx" ON "claims" USING gin ("entities");