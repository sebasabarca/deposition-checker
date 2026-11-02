ALTER TYPE "public"."llm_stage" ADD VALUE 'discovery';--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discovery_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"analysis_id" bigint NOT NULL,
	"attempt" integer NOT NULL,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"effort" text NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"status" text NOT NULL,
	"batch_id" text,
	"custom_id" text NOT NULL,
	"reservation_id" bigint,
	"max_cost_usd" numeric(14, 8) NOT NULL,
	"llm_call_id" bigint,
	"stop_reason" text,
	"refusal_category" text,
	"error" text,
	"output" jsonb,
	"audit" jsonb,
	"source_hashes" jsonb NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "discovery_runs_attempt_unique" UNIQUE("analysis_id","attempt"),
	CONSTRAINT "discovery_runs_attempt_check" CHECK ("discovery_runs"."attempt" in (1, 2)),
	CONSTRAINT "discovery_runs_status_check" CHECK ("discovery_runs"."status" in ('submitting', 'submitted', 'succeeded', 'refused', 'invalid_output', 'incomplete', 'provider_failed', 'expired', 'cancelled', 'submission_unknown'))
);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_reservation_id_budget_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;