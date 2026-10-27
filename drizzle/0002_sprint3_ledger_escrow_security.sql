CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"influencer_slug" varchar(16) NOT NULL,
	"payout_id" uuid,
	"entry_type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'MXN' NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_type_valid" CHECK ("ledger_entries"."entry_type" IN ('escrow_release', 'clawback', 'withdrawal_adjustment')),
	CONSTRAINT "ledger_amount_sign" CHECK (("ledger_entries"."entry_type" = 'escrow_release' AND "ledger_entries"."amount" >= 0) OR ("ledger_entries"."entry_type" = 'clawback' AND "ledger_entries"."amount" <= 0) OR "ledger_entries"."entry_type" = 'withdrawal_adjustment')
);
--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_status_valid";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "platform_fee_rate" numeric(5, 4) DEFAULT '0.0300' NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "platform_fee_rate" numeric(5, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "platform_fee_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "clawed_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_influencer_slug_idx" ON "ledger_entries" USING btree ("influencer_slug");--> statement-breakpoint
CREATE INDEX "ledger_payout_id_idx" ON "ledger_entries" USING btree ("payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_payout_entry_type_unique" ON "ledger_entries" USING btree ("payout_id","entry_type") WHERE "ledger_entries"."entry_type" IN ('escrow_release', 'clawback');--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_platform_fee_rate_range" CHECK ("campaigns"."platform_fee_rate" >= 0 AND "campaigns"."platform_fee_rate" < 1);--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_valid" CHECK ("payouts"."status" IN ('in_escrow', 'released', 'cancelled', 'clawed_back'));--> statement-breakpoint
-- Hand-written: the ledger is append-only. Corrections must be posted as new entries.
CREATE FUNCTION "ledger_entries_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ledger_entries_no_update_delete" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_immutable"();--> statement-breakpoint
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_entries_immutable"();
