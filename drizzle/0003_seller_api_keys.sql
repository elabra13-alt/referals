ALTER TABLE "sellers" ADD COLUMN "api_key_hash" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_api_key_hash_unique" UNIQUE("api_key_hash");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_status_valid" CHECK ("campaigns"."status" IN ('active', 'paused', 'ended'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_status_valid" CHECK ("products"."status" IN ('active', 'paused', 'archived'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_margin_non_negative" CHECK ("products"."margin" >= 0);--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_status_valid" CHECK ("sellers"."status" IN ('active', 'suspended'));