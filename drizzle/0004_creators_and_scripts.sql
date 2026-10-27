CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(16) NOT NULL,
	"handle" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"email" varchar(255) NOT NULL,
	"niche" varchar(32) NOT NULL,
	"followers_count" integer DEFAULT 0 NOT NULL,
	"engagement_rate" numeric(5, 4) DEFAULT '0.0300' NOT NULL,
	"spei_clabe" char(18),
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_slug_unique" UNIQUE("slug"),
	CONSTRAINT "creators_email_unique" UNIQUE("email"),
	CONSTRAINT "creators_clabe_format" CHECK ("creators"."spei_clabe" IS NULL OR "creators"."spei_clabe" ~ '^[0-9]{18}$'),
	CONSTRAINT "creators_status_valid" CHECK ("creators"."status" IN ('active', 'suspended')),
	CONSTRAINT "creators_slug_format" CHECK ("creators"."slug" ~ '^[A-Z0-9]{3,16}$'),
	CONSTRAINT "creators_followers_non_negative" CHECK ("creators"."followers_count" >= 0),
	CONSTRAINT "creators_engagement_rate_range" CHECK ("creators"."engagement_rate" >= 0 AND "creators"."engagement_rate" <= 1)
);
--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "custom_script" text;--> statement-breakpoint
CREATE INDEX "creators_niche_idx" ON "creators" USING btree ("niche");--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "links_influencer_slug_idx" ON "links" USING btree ("influencer_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "links_campaign_creator_unique" ON "links" USING btree ("campaign_id","creator_id") WHERE "links"."creator_id" IS NOT NULL;