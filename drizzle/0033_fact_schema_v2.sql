ALTER TABLE "fact_units" DROP CONSTRAINT "fact_units_status_check";--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "entities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "attribute" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "value_phrase" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "context_span_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "value_support" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "semantic_status" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "review_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "correction" boolean;--> statement-breakpoint
ALTER TABLE "fact_units" ADD CONSTRAINT "fact_units_status_check" CHECK ("fact_units"."status" in ('pending', 'extracted', 'empty', 'suspected_omission', 'no_testimony', 'omitted', 'failed', 'incomplete'));