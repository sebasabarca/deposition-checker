ALTER TABLE "findings" ADD COLUMN "context_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing findings take the flag from the verdict they were scored from, not the default.
UPDATE "findings" SET "context_requested" = ("verdicts"."parsed"->>'needsMoreContext')::boolean FROM "verdicts" WHERE "verdicts"."id" = "findings"."verdict_id" AND "verdicts"."parsed" IS NOT NULL;
