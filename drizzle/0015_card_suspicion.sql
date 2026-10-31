ALTER TYPE "public"."card_coverage_status" ADD VALUE 'suspected_omission';--> statement-breakpoint
ALTER TABLE "card_coverage" ADD COLUMN "suspicion_signals" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "card_coverage" ADD COLUMN "suspected_call_id" bigint;--> statement-breakpoint
ALTER TABLE "card_coverage" ADD CONSTRAINT "card_coverage_suspected_call_id_llm_calls_id_fk" FOREIGN KEY ("suspected_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;