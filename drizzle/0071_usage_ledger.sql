CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"source" text DEFAULT 'unknown' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"task_key" text,
	"agent_id" uuid,
	"parent_kind" text,
	"parent_id" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6)
);
--> statement-breakpoint
CREATE INDEX "usage_ledger_ts" ON "usage_ledger" USING btree ("ts");