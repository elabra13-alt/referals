ALTER TABLE "creators" ADD COLUMN "api_key_hash" text;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_api_key_hash_unique" UNIQUE("api_key_hash");