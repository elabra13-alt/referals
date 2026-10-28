CREATE TABLE "creator_login_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_login_tokens" ADD CONSTRAINT "creator_login_tokens_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_login_token_hash_idx" ON "creator_login_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "creator_login_creator_id_idx" ON "creator_login_tokens" USING btree ("creator_id");