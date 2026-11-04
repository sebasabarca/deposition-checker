CREATE TABLE "screening_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "screening_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"packet_id" text NOT NULL,
	"rank" integer,
	"screen_status" text NOT NULL,
	"consolidated_into" text,
	"reason" text NOT NULL,
	"priority" double precision NOT NULL,
	"signals" jsonb NOT NULL,
	"sessions" jsonb NOT NULL,
	"witnesses" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"pairs" jsonb NOT NULL,
	"adjudication_status" text DEFAULT 'not_started' NOT NULL,
	"adjudication_ref" text,
	"adjudication_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screening_entries_run_packet_unique" UNIQUE("run_id","packet_id"),
	CONSTRAINT "screening_entries_screen_status_check" CHECK ("screening_entries"."screen_status" in ('prioritized', 'deferred', 'consolidated')),
	CONSTRAINT "screening_entries_adjudication_status_check" CHECK ("screening_entries"."adjudication_status" in ('not_started', 'in_progress', 'adjudicated', 'failed')),
	CONSTRAINT "screening_entries_consolidated_check" CHECK (("screening_entries"."screen_status" = 'consolidated') = ("screening_entries"."consolidated_into" is not null) and ("screening_entries"."screen_status" = 'consolidated') = ("screening_entries"."rank" is null))
);
--> statement-breakpoint
CREATE TABLE "screening_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "screening_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"corpus" text NOT NULL,
	"packet_set_name" text NOT NULL,
	"packet_set_sha256" text NOT NULL,
	"pool_sha256" text NOT NULL,
	"items_sha256" text NOT NULL,
	"strategy" text NOT NULL,
	"strategy_version" text NOT NULL,
	"contract" text NOT NULL,
	"budget" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"pool_pairs" integer NOT NULL,
	"uncovered" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screening_entries" ADD CONSTRAINT "screening_entries_run_id_screening_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."screening_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screening_entries_queue_idx" ON "screening_entries" USING btree ("run_id","adjudication_status","rank");