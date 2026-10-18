ALTER TABLE "tasks" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claim_expires_at" timestamp with time zone;