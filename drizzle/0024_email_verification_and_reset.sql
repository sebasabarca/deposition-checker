CREATE TYPE "public"."auth_token_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analysis_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_tokens_user_id_idx" ON "auth_tokens" USING btree ("user_id");