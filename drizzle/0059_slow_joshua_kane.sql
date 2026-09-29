CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"title" text,
	"url" text,
	"state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "work_link_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cycle_id" uuid;--> statement-breakpoint
CREATE INDEX "cycles_project" ON "cycles" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_external_ref" ON "cycles" USING btree ("external_ref") WHERE "cycles"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_unique" ON "task_links" USING btree ("task_id","kind","ref");--> statement-breakpoint
CREATE INDEX "task_links_ref" ON "task_links" USING btree ("kind","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "task_relations_pair" ON "task_relations" USING btree ("from_id","to_id","kind");--> statement-breakpoint
CREATE INDEX "task_relations_to" ON "task_relations" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "tasks_cycle" ON "tasks" USING btree ("cycle_id");