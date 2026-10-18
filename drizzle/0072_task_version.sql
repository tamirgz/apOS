ALTER TABLE "tasks" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency" ON "tasks" USING btree (coalesce("project_ref", ''),"idempotency_key") WHERE "tasks"."idempotency_key" is not null;