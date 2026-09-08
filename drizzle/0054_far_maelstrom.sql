CREATE TABLE "chat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_key" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"model" text,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text,
	"error" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_runs_created" ON "chat_runs" USING btree ("created_at");