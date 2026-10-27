CREATE TABLE "creator_storefront_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"custom_hook_text" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_items_hook_length" CHECK ("creator_storefront_items"."custom_hook_text" IS NULL OR char_length("creator_storefront_items"."custom_hook_text") <= 280)
);
--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "instagram_handle" varchar(50);--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "tiktok_handle" varchar(50);--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "is_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_storefront_items" ADD CONSTRAINT "creator_storefront_items_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_storefront_items" ADD CONSTRAINT "creator_storefront_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_storefront_items" ADD CONSTRAINT "creator_storefront_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_storefront_items" ADD CONSTRAINT "creator_storefront_items_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_product_unique_idx" ON "creator_storefront_items" USING btree ("creator_id","product_id");--> statement-breakpoint
CREATE INDEX "storefront_items_creator_order_idx" ON "creator_storefront_items" USING btree ("creator_id","is_active","display_order");