CREATE TABLE "case_run_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "case_run_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_run_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'submitting' NOT NULL,
	"provider_batch_id" text,
	"request_count" integer NOT NULL,
	"payload_bytes" integer NOT NULL,
	"max_cost_usd" numeric(14, 8) NOT NULL,
	"provider_status" text,
	"request_counts" jsonb,
	"results_imported" integer DEFAULT 0 NOT NULL,
	"error" text,
	"recovery" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"provider_created_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"imported_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_run_batches_seq_unique" UNIQUE("case_run_id","seq"),
	CONSTRAINT "case_run_batches_status_check" CHECK ("case_run_batches"."status" in ('submitting', 'submitted', 'canceling', 'ended', 'imported', 'not_submitted', 'submission_unknown'))
);
--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "case_run_batch_id" bigint;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "custom_id" text;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "screening_entry_id" bigint;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "round" integer;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD COLUMN "retry_of" bigint;--> statement-breakpoint
ALTER TABLE "case_runs" ADD COLUMN "execution" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "case_runs" ADD COLUMN "retention_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "case_run_batches" ADD CONSTRAINT "case_run_batches_case_run_id_case_runs_id_fk" FOREIGN KEY ("case_run_id") REFERENCES "public"."case_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_run_batches_provider_unique" ON "case_run_batches" USING btree ("provider_batch_id");--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD CONSTRAINT "adjudication_requests_case_run_batch_id_case_run_batches_id_fk" FOREIGN KEY ("case_run_batch_id") REFERENCES "public"."case_run_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjudication_requests" ADD CONSTRAINT "adjudication_requests_screening_entry_id_screening_entries_id_fk" FOREIGN KEY ("screening_entry_id") REFERENCES "public"."screening_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjudication_requests_custom_id_unique" ON "adjudication_requests" USING btree ("custom_id");--> statement-breakpoint
CREATE INDEX "adjudication_requests_batch_idx" ON "adjudication_requests" USING btree ("case_run_batch_id");--> statement-breakpoint
CREATE INDEX "adjudication_requests_entry_idx" ON "adjudication_requests" USING btree ("screening_entry_id");--> statement-breakpoint
ALTER TABLE "case_runs" ADD CONSTRAINT "case_runs_execution_check" CHECK ("case_runs"."execution" in ('standard', 'batch'));