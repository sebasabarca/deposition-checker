CREATE TYPE "public"."adjudication_request_status" AS ENUM('sent', 'completed', 'partial', 'failed', 'rate_limited', 'aborted', 'oversize');--> statement-breakpoint
ALTER TYPE "public"."analysis_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."analysis_status" ADD VALUE 'interrupted';--> statement-breakpoint
CREATE TABLE "adjudication_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "adjudication_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" text NOT NULL,
	"analysis_id" bigint,
	"candidate_set" text NOT NULL,
	"candidate_ids" bigint[] NOT NULL,
	"strategy" text NOT NULL,
	"max_concurrency" integer NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" "adjudication_request_status" DEFAULT 'sent' NOT NULL,
	"provider_request_id" text,
	"llm_call_id" bigint,
	"reservation_id" bigint,
	"estimated_input_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"max_cost_usd" numeric(14, 8) NOT NULL,
	"latency_ms" integer,
	"error_kind" text,
	"error" text,
	"retry_after_ms" integer,
	"missing_candidate_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"duplicate_candidate_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"unknown_candidate_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"contaminated_candidate_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"suspected_candidate_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"split_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "strategy" text DEFAULT 'A' NOT NULL;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "candidates_per_request" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "max_concurrency" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "runner_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "request_id" bigint;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD CONSTRAINT "adjudication_requests_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD CONSTRAINT "adjudication_requests_reservation_id_budget_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjudication_requests_set_idx" ON "adjudication_requests" USING btree ("candidate_set");--> statement-breakpoint
CREATE INDEX "adjudication_requests_analysis_idx" ON "adjudication_requests" USING btree ("analysis_id");--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_request_id_adjudication_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."adjudication_requests"("id") ON DELETE no action ON UPDATE no action;