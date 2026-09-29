CREATE TABLE "task_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"field" text,
	"from_value" text,
	"to_value" text,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_counters" (
	"scope" text PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "target_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimate" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sort_order" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "task_activity_task" ON "task_activity" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_project" ON "tasks" USING btree ("project_ref");--> statement-breakpoint
CREATE INDEX "tasks_parent" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_feature" ON "tasks" USING btree ("feature_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_external_ref" ON "tasks" USING btree ("external_ref") WHERE "tasks"."external_ref" is not null;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_key_unique" UNIQUE("key");--> statement-breakpoint
-- Backfill: existing items get a real updated_at and a stable manual order (creation order).
UPDATE "tasks" SET "updated_at" = coalesce("completed_at", "created_at"), "sort_order" = extract(epoch from "created_at");--> statement-breakpoint
-- Backfill: a feature whose items are all closed has already shipped.
UPDATE "features" f SET "status" = 'shipped', "shipped_at" = s.last_done
FROM (
  SELECT "feature_ref", max(coalesce("completed_at", "created_at")) AS last_done
  FROM "tasks" WHERE "feature_ref" IS NOT NULL
  GROUP BY "feature_ref"
  HAVING bool_and("status" IN ('done', 'cancelled'))
) s
WHERE s."feature_ref" = 'features:' || f."id";
