ALTER TYPE "public"."deposition_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TABLE "depositions" ALTER COLUMN "page_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "depositions" ALTER COLUMN "validation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "depositions" ADD COLUMN "ingest_error" text;--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_read_check" CHECK (("depositions"."validation" is null) = ("depositions"."page_count" is null) and ("depositions"."validation" is not null or "depositions"."status"::text in ('processing', 'failed')));--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_ingest_error_check" CHECK (("depositions"."status"::text = 'failed') = ("depositions"."ingest_error" is not null));