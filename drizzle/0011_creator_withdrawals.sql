CREATE TABLE "withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'MXN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"clabe" char(18) NOT NULL,
	"bank_code" char(3) NOT NULL,
	"bank_name" text,
	"beneficiary_name" text NOT NULL,
	"rfc" varchar(13),
	"ledger_entry_id" uuid NOT NULL,
	"idempotency_key" varchar(100),
	"tracking_key" varchar(30),
	"failure_reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "withdrawals_status_valid" CHECK ("withdrawal_requests"."status" IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
	CONSTRAINT "withdrawals_amount_positive" CHECK ("withdrawal_requests"."amount" > 0),
	CONSTRAINT "withdrawals_clabe_format" CHECK ("withdrawal_requests"."clabe" ~ '^[0-9]{18}$')
);
--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "payout_legal_name" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "rfc" varchar(13);--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "spei_clabe_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawals_creator_requested_idx" ON "withdrawal_requests" USING btree ("creator_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_creator_idempotency_key_idx" ON "withdrawal_requests" USING btree ("creator_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_ledger_entry_idx" ON "withdrawal_requests" USING btree ("ledger_entry_id");