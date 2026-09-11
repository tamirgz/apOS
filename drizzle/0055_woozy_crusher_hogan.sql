CREATE TABLE IF NOT EXISTS "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'unknown' NOT NULL,
	"parent_kind" text,
	"parent_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_calls_started" ON "model_calls" USING btree ("started_at");