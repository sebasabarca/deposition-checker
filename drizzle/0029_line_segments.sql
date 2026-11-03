CREATE TABLE "line_segments" (
	"line_id" bigint NOT NULL,
	"deposition_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"speaker_role" "speaker_role" NOT NULL,
	"speaker_name" text,
	CONSTRAINT "line_segments_pk" PRIMARY KEY("line_id","seq"),
	CONSTRAINT "line_segments_range_check" CHECK ("line_segments"."start_offset" >= 0 and "line_segments"."end_offset" > "line_segments"."start_offset")
);
--> statement-breakpoint
ALTER TABLE "line_segments" ADD CONSTRAINT "line_segments_line_fk" FOREIGN KEY ("line_id","deposition_id") REFERENCES "public"."lines"("id","deposition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "line_segments_deposition_idx" ON "line_segments" USING btree ("deposition_id");