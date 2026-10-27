CREATE TABLE "campaign_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"match_score" integer NOT NULL,
	"match_reason" varchar(255) NOT NULL,
	"custom_note" varchar(500),
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_status_valid" CHECK ("campaign_invitations"."status" IN ('pending', 'accepted', 'declined', 'expired')),
	CONSTRAINT "invitation_match_score_range" CHECK ("campaign_invitations"."match_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "campaign_invitations" ADD CONSTRAINT "campaign_invitations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_invitations" ADD CONSTRAINT "campaign_invitations_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_invitations" ADD CONSTRAINT "campaign_invitations_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_campaign_creator_idx" ON "campaign_invitations" USING btree ("campaign_id","creator_id");--> statement-breakpoint
CREATE INDEX "invitation_seller_status_idx" ON "campaign_invitations" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "invitation_creator_status_idx" ON "campaign_invitations" USING btree ("creator_id","status");