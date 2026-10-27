ALTER TABLE "creators" ADD COLUMN "phone" varchar(25);--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "whatsapp_opt_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_phone_e164" CHECK ("creators"."phone" IS NULL OR "creators"."phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_whatsapp_opt_in_needs_phone" CHECK ("creators"."whatsapp_opt_in_at" IS NULL OR "creators"."phone" IS NOT NULL);