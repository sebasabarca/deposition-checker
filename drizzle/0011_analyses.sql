CREATE TYPE "public"."analysis_status" AS ENUM('queued', 'parsing', 'retrieving', 'adjudicating', 'completed', 'failed', 'blocked_budget', 'blocked_credentials');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analyses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"deposition_a" bigint NOT NULL,
	"deposition_b" bigint NOT NULL,
	"mode" text NOT NULL,
	"prompt_version" text NOT NULL,
	"effort" text NOT NULL,
	"max_candidates" integer NOT NULL,
	"budget_usd" numeric(14, 8) NOT NULL,
	"budget_id" bigint,
	"status" "analysis_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_mode_check" CHECK ("analyses"."mode" in ('live', 'demo')),
	CONSTRAINT "analyses_pair_check" CHECK ("analyses"."deposition_a" <> "analyses"."deposition_b"),
	CONSTRAINT "analyses_budget_check" CHECK ("analyses"."budget_usd" >= 0 and "analyses"."max_candidates" > 0)
);
--> statement-breakpoint
ALTER TABLE "verdicts" ALTER COLUMN "llm_call_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "depositions" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "origin" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "replay_of" bigint;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_witness_id_witnesses_id_fk" FOREIGN KEY ("witness_id") REFERENCES "public"."witnesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_deposition_a_depositions_id_fk" FOREIGN KEY ("deposition_a") REFERENCES "public"."depositions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_deposition_b_depositions_id_fk" FOREIGN KEY ("deposition_b") REFERENCES "public"."depositions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_case_idx" ON "analyses" USING btree ("case_id","id");--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_origin_check" CHECK ("verdicts"."origin" in ('model', 'replayed', 'fixture') and ("verdicts"."origin" = 'model') = ("verdicts"."llm_call_id" is not null) and ("verdicts"."origin" = 'replayed') = ("verdicts"."replay_of" is not null));