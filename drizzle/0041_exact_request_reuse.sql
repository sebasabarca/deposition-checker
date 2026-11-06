ALTER TYPE "public"."adjudication_request_status" ADD VALUE 'reused';--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "evidence_key" text;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "reused_from_request_id" bigint;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "avoided_cost_usd" numeric(14, 8);--> statement-breakpoint
CREATE INDEX "adjudication_requests_fingerprint_idx" ON "adjudication_requests" USING btree ("request_fingerprint");--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD CONSTRAINT "adjudication_requests_reused_check" CHECK (("adjudication_requests"."status"::text = 'reused') = ("adjudication_requests"."reused_from_request_id" is not null) and ("adjudication_requests"."status"::text <> 'reused' or ("adjudication_requests"."llm_call_id" is null and "adjudication_requests"."reservation_id" is null and "adjudication_requests"."max_cost_usd" = 0)));