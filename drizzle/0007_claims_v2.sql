ALTER TYPE "public"."claim_epistemic" ADD VALUE 'does_not_know' BEFORE 'does_not_recall';--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "ungrounded_entities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "depends_on_earlier" boolean;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "hedge" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "context_dependent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "context_reason" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "thinking_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "raw_output" text;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_context_check" CHECK ("claims"."context_dependent" = ("claims"."context_reason" is not null));