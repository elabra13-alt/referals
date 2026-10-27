ALTER TABLE "campaigns" ADD COLUMN "is_public_catalog" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "requires_verified_creator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "campaigns_public_catalog_idx" ON "campaigns" USING btree ("status") WHERE "campaigns"."is_public_catalog" = true;