CREATE TABLE "evidence_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"deposition_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"version" text NOT NULL,
	"from_parser" text NOT NULL,
	"to_parser" text NOT NULL,
	"plan_hash" text,
	"plan" jsonb,
	"before_hash" text NOT NULL,
	"after_hash" text,
	"backup" text,
	"rollback_of" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "evidence_migrations_kind_check" CHECK ("evidence_migrations"."kind" in ('correction', 'rollback', 'quarantine')),
	CONSTRAINT "evidence_migrations_status_check" CHECK ("evidence_migrations"."status" in ('holding', 'applied', 'rolled_back', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "evidence_quarantine" (
	"migration_id" text NOT NULL,
	"kind" text NOT NULL,
	"row_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"prior" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_quarantine_pk" PRIMARY KEY("migration_id","kind","row_id"),
	CONSTRAINT "evidence_quarantine_kind_check" CHECK ("evidence_quarantine"."kind" in ('finding', 'verdict', 'candidate'))
);
--> statement-breakpoint
ALTER TABLE "depositions" ADD COLUMN "evidence_hold" text;--> statement-breakpoint
ALTER TABLE "depositions" ADD COLUMN "evidence_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_migrations" ADD CONSTRAINT "evidence_migrations_deposition_id_depositions_id_fk" FOREIGN KEY ("deposition_id") REFERENCES "public"."depositions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_quarantine" ADD CONSTRAINT "evidence_quarantine_migration_id_evidence_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."evidence_migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_migrations_deposition_idx" ON "evidence_migrations" USING btree ("deposition_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_migrations_plan_applied" ON "evidence_migrations" USING btree ("deposition_id","plan_hash") WHERE "evidence_migrations"."status" = 'applied' and "evidence_migrations"."kind" = 'correction';--> statement-breakpoint
CREATE INDEX "evidence_quarantine_row_idx" ON "evidence_quarantine" USING btree ("kind","row_id");--> statement-breakpoint
-- Evidence holds, enforced by the database (written by hand; drizzle-kit doesn't model triggers). While a
-- correction or rollback holds a deposition (depositions.evidence_hold), any write to its lines, segments,
-- exchanges or anything derived from them fails with SQLSTATE VE001, unless the writing transaction is the
-- holder (SET LOCAL evidence.migration = '<id>'). Each check takes FOR KEY SHARE on the deposition row, as a
-- foreign key check does: a correction's FOR UPDATE therefore waits for writers already running, and writers
-- that start during it wait, then see the hold and fail. Workers need no lock of their own to be safe.
CREATE FUNCTION evidence_guard(ids bigint[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE held record;
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  FOR held IN SELECT id, evidence_hold FROM depositions WHERE id = ANY(ids) ORDER BY id FOR KEY SHARE LOOP
    IF held.evidence_hold IS NOT NULL AND held.evidence_hold IS DISTINCT FROM current_setting('evidence.migration', true) THEN
      RAISE EXCEPTION 'evidence_on_hold: deposition % is held by evidence migration %', held.id, held.evidence_hold USING ERRCODE = 'VE001';
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION evidence_guard_by_deposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM evidence_guard(ARRAY(SELECT DISTINCT deposition_id FROM changed)); RETURN NULL; END $$;
--> statement-breakpoint
CREATE FUNCTION evidence_guard_candidates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM evidence_guard(ARRAY(SELECT deposition_a FROM changed UNION SELECT deposition_b FROM changed)); RETURN NULL; END $$;
--> statement-breakpoint
CREATE FUNCTION evidence_guard_by_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM evidence_guard(ARRAY(SELECT c.deposition_a FROM changed x JOIN candidates c ON c.id = x.candidate_id UNION SELECT c.deposition_b FROM changed x JOIN candidates c ON c.id = x.candidate_id)); RETURN NULL; END $$;
--> statement-breakpoint
CREATE FUNCTION evidence_guard_screening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM evidence_guard(ARRAY(SELECT DISTINCT unnest(document_ids) FROM changed)); RETURN NULL; END $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  fn text;
BEGIN
  FOR t, fn IN SELECT * FROM (VALUES
    ('lines', 'evidence_guard_by_deposition'), ('line_segments', 'evidence_guard_by_deposition'), ('exchanges', 'evidence_guard_by_deposition'),
    ('exchange_lines', 'evidence_guard_by_deposition'), ('statement_cards', 'evidence_guard_by_deposition'), ('card_coverage', 'evidence_guard_by_deposition'),
    ('claims', 'evidence_guard_by_deposition'), ('claim_tagging', 'evidence_guard_by_deposition'), ('fact_units', 'evidence_guard_by_deposition'),
    ('facts', 'evidence_guard_by_deposition'), ('candidates', 'evidence_guard_candidates'), ('verdicts', 'evidence_guard_by_candidate'),
    ('findings', 'evidence_guard_by_candidate'), ('screening_entries', 'evidence_guard_screening')) v(t, fn)
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION %I()', t || '_evidence_guard_insert', t, fn);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION %I()', t || '_evidence_guard_update', t, fn);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION %I()', t || '_evidence_guard_delete', t, fn);
  END LOOP;
END $$;
--> statement-breakpoint
-- The deposition row itself: while held, it can't be deleted (its rows would cascade away before the guard
-- above could see the hold) and only its hold and epoch may change, except by the holder.
CREATE FUNCTION evidence_guard_deposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence_hold IS NOT NULL AND OLD.evidence_hold IS DISTINCT FROM current_setting('evidence.migration', true)
     AND (TG_OP = 'DELETE' OR to_jsonb(NEW) - 'evidence_hold' - 'evidence_epoch' IS DISTINCT FROM to_jsonb(OLD) - 'evidence_hold' - 'evidence_epoch') THEN
    RAISE EXCEPTION 'evidence_on_hold: deposition % is held by evidence migration %', OLD.id, OLD.evidence_hold USING ERRCODE = 'VE001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER depositions_evidence_guard BEFORE UPDATE OR DELETE ON depositions FOR EACH ROW EXECUTE FUNCTION evidence_guard_deposition();
