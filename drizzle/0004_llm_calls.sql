CREATE TYPE "public"."llm_stage" AS ENUM('claim_tagging', 'adjudication');--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint,
	"stage" "llm_stage" NOT NULL,
	"model" text NOT NULL,
	"items" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_write_5m_tokens" integer NOT NULL,
	"cache_write_1h_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"batch" boolean DEFAULT false NOT NULL,
	"attempt" integer NOT NULL,
	"price_version" text,
	"cost_usd" numeric(14, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_tokens_check" CHECK ("llm_calls"."input_tokens" >= 0 and "llm_calls"."output_tokens" >= 0 and "llm_calls"."cache_write_5m_tokens" >= 0 and "llm_calls"."cache_write_1h_tokens" >= 0 and "llm_calls"."cache_read_tokens" >= 0),
	CONSTRAINT "llm_calls_counts_check" CHECK ("llm_calls"."items" >= 1 and "llm_calls"."attempt" >= 1),
	CONSTRAINT "llm_calls_priced_check" CHECK (("llm_calls"."cost_usd" is null) = ("llm_calls"."price_version" is null) and ("llm_calls"."cost_usd" is null or "llm_calls"."cost_usd" >= 0))
);
--> statement-breakpoint
CREATE INDEX "llm_calls_job_stage_idx" ON "llm_calls" USING btree ("job_id","stage");