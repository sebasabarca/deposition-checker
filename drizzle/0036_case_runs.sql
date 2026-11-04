ALTER TYPE "public"."candidate_status" ADD VALUE 'uncovered';--> statement-breakpoint
CREATE TABLE "case_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "case_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"budget_usd" numeric(14, 8) NOT NULL,
	"budget_id" bigint,
	"config" jsonb NOT NULL,
	"source_hash" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"runner_id" text,
	"runner_seen_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_runs_mode_check" CHECK ("case_runs"."mode" in ('live', 'mock')),
	CONSTRAINT "case_runs_budget_check" CHECK ("case_runs"."budget_usd" >= 0),
	CONSTRAINT "case_runs_status_check" CHECK ("case_runs"."status" in ('queued', 'retrieving', 'awaiting_confirmation', 'adjudicating', 'completed', 'incomplete', 'failed', 'blocked_budget', 'blocked_credentials', 'cancelled', 'interrupted'))
);
--> statement-breakpoint
ALTER TABLE "screening_entries" DROP CONSTRAINT "screening_entries_adjudication_status_check";--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "candidate_ids" bigint[];--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "exchange_ids" bigint[];--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "document_ids" bigint[];--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "session_ids" bigint[];--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "request_id" bigint;--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "llm_call_id" bigint;--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "failure_billable" boolean;--> statement-breakpoint
ALTER TABLE "screening_entries" ADD COLUMN "unresolved_pairs" jsonb;--> statement-breakpoint
ALTER TABLE "screening_runs" ADD COLUMN "case_id" bigint;--> statement-breakpoint
ALTER TABLE "screening_runs" ADD COLUMN "case_run_id" bigint;--> statement-breakpoint
ALTER TABLE "screening_runs" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "case_runs" ADD CONSTRAINT "case_runs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_runs" ADD CONSTRAINT "case_runs_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_runs_case_idx" ON "case_runs" USING btree ("case_id","id");--> statement-breakpoint
ALTER TABLE "screening_runs" ADD CONSTRAINT "screening_runs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_runs" ADD CONSTRAINT "screening_runs_case_run_id_case_runs_id_fk" FOREIGN KEY ("case_run_id") REFERENCES "public"."case_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_entries" ADD CONSTRAINT "screening_entries_adjudication_status_check" CHECK ("screening_entries"."adjudication_status" in ('not_started', 'in_progress', 'adjudicated', 'incomplete', 'failed'));