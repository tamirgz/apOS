ALTER TABLE "projects" ADD COLUMN "repo_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_sync_error" text;