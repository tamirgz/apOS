CREATE TABLE "project_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"notes" text,
	"decided_at" timestamp with time zone NOT NULL,
	"task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"source" text,
	"superseded_by" uuid,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_decisions_number" ON "project_decisions" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "project_decisions_source" ON "project_decisions" USING btree ("project_id","source");--> statement-breakpoint
CREATE INDEX "project_decisions_decided" ON "project_decisions" USING btree ("project_id","decided_at");--> statement-breakpoint
CREATE INDEX "project_decisions_tasks" ON "project_decisions" USING gin ("task_ids");