CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"buyer_email" varchar(255),
	"buyer_phone" varchar(20),
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"auto_apply_url" text NOT NULL,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "codes_code_unique" UNIQUE("code"),
	CONSTRAINT "codes_buyer_contact_present" CHECK ("codes"."buyer_email" IS NOT NULL OR "codes"."buyer_phone" IS NOT NULL),
	CONSTRAINT "codes_status_valid" CHECK ("codes"."status" IN ('issued', 'redeemed', 'expired', 'revoked')),
	CONSTRAINT "codes_code_format" CHECK ("codes"."code" ~ '^REF-[A-Z0-9]{3,5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$')
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"influencer_slug" varchar(16) NOT NULL,
	"link_slug" varchar(64) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "links_link_slug_unique" UNIQUE("link_slug")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'MXN' NOT NULL,
	"margin" numeric(12, 2) NOT NULL,
	"checkout_base_url" text NOT NULL,
	"category" text NOT NULL,
	"escrow_days" integer DEFAULT 21 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_non_negative" CHECK ("products"."price" >= 0),
	CONSTRAINT "products_escrow_days_positive" CHECK ("products"."escrow_days" > 0)
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codes" ADD CONSTRAINT "codes_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_product_id_idx" ON "campaigns" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "codes_link_id_buyer_phone_idx" ON "codes" USING btree ("link_id","buyer_phone");--> statement-breakpoint
CREATE INDEX "codes_link_id_buyer_email_idx" ON "codes" USING btree ("link_id","buyer_email");--> statement-breakpoint
CREATE INDEX "links_campaign_id_idx" ON "links" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "products_seller_id_idx" ON "products" USING btree ("seller_id");