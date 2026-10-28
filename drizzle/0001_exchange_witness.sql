-- Hand-edited after drizzle-kit generate, so it also works on a database that already holds
-- exchanges: add the column as nullable, copy each exchange's witness from its deposition, then
-- require it. The unique constraint comes before the foreign key that depends on it.
ALTER TABLE "depositions" ADD CONSTRAINT "depositions_id_witness_unique" UNIQUE("id","witness_id");--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "witness_id" bigint;--> statement-breakpoint
UPDATE "exchanges" SET "witness_id" = "depositions"."witness_id" FROM "depositions" WHERE "depositions"."id" = "exchanges"."deposition_id";--> statement-breakpoint
ALTER TABLE "exchanges" ALTER COLUMN "witness_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_deposition_witness_fk" FOREIGN KEY ("deposition_id","witness_id") REFERENCES "public"."depositions"("id","witness_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchanges_witness_deposition_idx" ON "exchanges" USING btree ("witness_id","deposition_id");
