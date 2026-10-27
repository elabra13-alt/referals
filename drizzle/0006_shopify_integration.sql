ALTER TABLE "sellers" ADD COLUMN "shopify_shop_domain" varchar(255);--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "shopify_access_token" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "shopify_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "shopify_discount_percentage" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_shopify_shop_domain_unique" UNIQUE("shopify_shop_domain");--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_shopify_config_complete" CHECK (("sellers"."shopify_shop_domain" IS NULL AND "sellers"."shopify_access_token" IS NULL AND "sellers"."shopify_webhook_secret" IS NULL AND "sellers"."shopify_discount_percentage" IS NULL)
        OR ("sellers"."shopify_shop_domain" IS NOT NULL AND "sellers"."shopify_access_token" IS NOT NULL AND "sellers"."shopify_webhook_secret" IS NOT NULL AND "sellers"."shopify_discount_percentage" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_shopify_discount_range" CHECK ("sellers"."shopify_discount_percentage" IS NULL OR ("sellers"."shopify_discount_percentage" > 0 AND "sellers"."shopify_discount_percentage" <= 100));