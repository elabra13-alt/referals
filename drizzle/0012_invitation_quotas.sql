ALTER TABLE "campaign_invitations" ADD COLUMN "sent_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "invitation_seller_sent_idx" ON "campaign_invitations" USING btree ("seller_id","sent_at");--> statement-breakpoint
-- Hand-written backfill: existing invitations were sent when created, not at migration time
-- (otherwise every pre-existing invitation would count against sellers' next 24h quota).
UPDATE "campaign_invitations" SET "sent_at" = "created_at";
