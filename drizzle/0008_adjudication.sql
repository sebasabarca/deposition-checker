CREATE TYPE "public"."candidate_status" AS ENUM('selected', 'deferred', 'audit', 'adjudicated');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('reserved', 'settled', 'released', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."verdict_status" AS ENUM('valid', 'schema_invalid', 'refused', 'cut_off');--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "budget_reservations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"budget_id" bigint NOT NULL,
	"purpose" text NOT NULL,
	"max_usd" numeric(14, 8) NOT NULL,
	"actual_usd" numeric(14, 8),
	"status" "reservation_status" DEFAULT 'reserved' NOT NULL,
	"llm_call_id" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_max_check" CHECK ("budget_reservations"."max_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "budgets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"limit_usd" numeric(14, 8) NOT NULL,
	"spent_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"reserved_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_name_unique" UNIQUE("name"),
	CONSTRAINT "budgets_amounts_check" CHECK ("budgets"."limit_usd" >= 0 and "budgets"."spent_usd" >= 0 and "budgets"."reserved_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_set" text NOT NULL,
	"job_id" bigint,
	"witness_id" bigint NOT NULL,
	"deposition_a" bigint NOT NULL,
	"group_a" integer NOT NULL,
	"deposition_b" bigint NOT NULL,
	"group_b" integer NOT NULL,
	"exchange_a" bigint NOT NULL,
	"exchange_b" bigint NOT NULL,
	"sources" text[] NOT NULL,
	"rank_claims" integer,
	"rank_fulltext" integer,
	"rrf_score" real NOT NULL,
	"merged_rank" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" "candidate_status" DEFAULT 'selected' NOT NULL,
	"deferred_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_pair_unique" UNIQUE("candidate_set","deposition_a","group_a","deposition_b","group_b"),
	CONSTRAINT "candidates_order_check" CHECK (("candidates"."deposition_a", "candidates"."group_a") < ("candidates"."deposition_b", "candidates"."group_b"))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "findings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"candidate_id" bigint NOT NULL,
	"verdict_id" bigint NOT NULL,
	"type" text NOT NULL,
	"evidence_status" text NOT NULL,
	"attribution_a" text NOT NULL,
	"attribution_b" text NOT NULL,
	"score" integer,
	"band" text,
	"unscored_reason" text,
	"factors" jsonb NOT NULL,
	"caps" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"rubric_version" text NOT NULL,
	"priority" text NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_verdict_id_unique" UNIQUE("verdict_id"),
	CONSTRAINT "findings_score_check" CHECK (("findings"."score" is null) = ("findings"."band" is null) and ("findings"."score" is null or "findings"."score" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verdicts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" bigint NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"effort" text NOT NULL,
	"status" "verdict_status" NOT NULL,
	"raw" text,
	"parsed" jsonb,
	"error" text,
	"packet" jsonb NOT NULL,
	"llm_call_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdicts_valid_check" CHECK (("verdicts"."status"::text = 'valid') = ("verdicts"."parsed" is not null))
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_exchange_a_fk" FOREIGN KEY ("exchange_a","deposition_a") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_exchange_b_fk" FOREIGN KEY ("exchange_b","deposition_b") REFERENCES "public"."exchanges"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_budget_idx" ON "budget_reservations" USING btree ("budget_id","status");--> statement-breakpoint
CREATE INDEX "findings_case_review_idx" ON "findings" USING btree ("case_id","review_state","priority","score","id");