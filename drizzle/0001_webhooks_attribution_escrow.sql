CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"commission_rate" numeric(5, 4) NOT NULL,
	"escrow_days" integer NOT NULL,
	"escrow_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'in_escrow' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_sale_id_unique" UNIQUE("sale_id"),
	CONSTRAINT "payouts_status_valid" CHECK ("payouts"."status" IN ('in_escrow', 'released', 'cancelled')),
	CONSTRAINT "payouts_amount_non_negative" CHECK ("payouts"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"seller_order_id" varchar(128) NOT NULL,
	"applied_discount_code" varchar(64),
	"code_id" uuid,
	"attributed" boolean NOT NULL,
	"attribution_reason" text NOT NULL,
	"currency" char(3) NOT NULL,
	"gross_total" numeric(12, 2) NOT NULL,
	"discount_total" numeric(12, 2) NOT NULL,
	"net_total" numeric(12, 2) NOT NULL,
	"customer_email" varchar(255),
	"status" text DEFAULT 'paid' NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refunded_at" timestamp with time zone,
	"refund_event" text,
	CONSTRAINT "sales_seller_id_seller_order_id_unique" UNIQUE("seller_id","seller_order_id"),
	CONSTRAINT "sales_status_valid" CHECK ("sales"."status" IN ('paid', 'refunded')),
	CONSTRAINT "sales_totals_non_negative" CHECK ("sales"."gross_total" >= 0 AND "sales"."discount_total" >= 0 AND "sales"."net_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "codes" DROP CONSTRAINT "codes_status_valid";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "commission_rate" numeric(5, 4) NOT NULL;--> statement-breakpoint
ALTER TABLE "codes" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_code_id_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_code_id_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_status_escrow_until_idx" ON "payouts" USING btree ("status","escrow_until");--> statement-breakpoint
CREATE INDEX "payouts_link_id_idx" ON "payouts" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "sales_code_id_idx" ON "sales" USING btree ("code_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_commission_rate_range" CHECK ("campaigns"."commission_rate" > 0 AND "campaigns"."commission_rate" <= 1);--> statement-breakpoint
ALTER TABLE "codes" ADD CONSTRAINT "codes_status_valid" CHECK ("codes"."status" IN ('issued', 'applied', 'expired', 'revoked'));