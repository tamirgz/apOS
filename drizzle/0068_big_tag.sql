CREATE TABLE "task_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"comment_id" uuid,
	"project_id" uuid,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"caption" text,
	"storage_path" text NOT NULL,
	"source_path" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE INDEX "task_attachments_task" ON "task_attachments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_attachments_project_sha" ON "task_attachments" USING btree ("project_id","sha256");