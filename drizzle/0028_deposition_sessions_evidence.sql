CREATE TABLE "deposition_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deposition_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"witness_id" bigint NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposition_sessions_id_witness_unique" UNIQUE("id","witness_id")
);
--> statement-breakpoint
ALTER TABLE "depositions" ADD COLUMN "session_id" bigint DEFAULT NULL;--> statement-breakpoint
-- Every existing deposition was one file of its own session: give each a session with the same ID.
INSERT INTO "deposition_sessions" ("id", "case_id", "witness_id", "created_at") OVERRIDING SYSTEM VALUE SELECT "id", "case_id", "witness_id", "created_at" FROM "depositions";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('"deposition_sessions"', 'id'), GREATEST((SELECT max("id") FROM "deposition_sessions"), 1));--> statement-breakpoint
UPDATE "depositions" SET "session_id" = "id";--> statement-breakpoint
ALTER TABLE "depositions" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "depositions" ADD COLUMN "session_part" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "evidence_key" text;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "text_hash" text;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "speaker_status" text;--> statement-breakpoint
ALTER TABLE "deposition_sessions" ADD CONSTRAINT "deposition_sessions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposition_sessions" ADD CONSTRAINT "deposition_sessions_witness_case_fk" FOREIGN KEY ("witness_id","case_id") REFERENCES "public"."witnesses"("id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposition_sessions_case_idx" ON "deposition_sessions" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_session_witness_fk" FOREIGN KEY ("session_id","witness_id") REFERENCES "public"."deposition_sessions"("id","witness_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchanges_evidence_key_idx" ON "exchanges" USING btree ("evidence_key");--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_session_part_unique" UNIQUE("session_id","session_part");--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_evidence_key_unique" UNIQUE("deposition_id","evidence_key");--> statement-breakpoint
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_session_part_check" CHECK ("depositions"."session_part" >= 1);--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_speaker_status_check" CHECK ("exchanges"."speaker_status" is null or "exchanges"."speaker_status" in ('verified', 'uncertain', 'invalid'));--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_evidence_fields_check" CHECK (("exchanges"."evidence_key" is null) = ("exchanges"."text_hash" is null) and ("exchanges"."evidence_key" is null) = ("exchanges"."speaker_status" is null));--> statement-breakpoint
-- A deposition stored without a session gets one of its own (one file, part 1). Files join a session
-- only when the caller names it: never by matching witness or date.
CREATE FUNCTION "deposition_session_default"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."session_id" IS NULL THEN
    INSERT INTO "deposition_sessions" ("case_id", "witness_id") VALUES (NEW."case_id", NEW."witness_id") RETURNING "id" INTO NEW."session_id";
    NEW."session_part" := 1;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "depositions_session_default" BEFORE INSERT ON "depositions" FOR EACH ROW EXECUTE FUNCTION "deposition_session_default"();--> statement-breakpoint
-- A session whose last file is deleted or moved to another session goes too.
CREATE FUNCTION "deposition_session_cleanup"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "deposition_sessions" s WHERE s."id" = OLD."session_id" AND NOT EXISTS (SELECT 1 FROM "depositions" d WHERE d."session_id" = s."id");
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "depositions_session_cleanup" AFTER DELETE OR UPDATE OF "session_id" ON "depositions" FOR EACH ROW EXECUTE FUNCTION "deposition_session_cleanup"();
