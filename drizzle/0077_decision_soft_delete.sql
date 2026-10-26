ALTER TABLE "project_decisions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD COLUMN "deleted_by" text;