ALTER TABLE "tasks" ADD COLUMN "acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workbench_tasks" ADD COLUMN "acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL;