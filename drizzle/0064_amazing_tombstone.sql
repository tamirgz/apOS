CREATE TABLE "milestone_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestone_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"capability_id" uuid,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"entity_kind" text,
	"label" text,
	"exclude" boolean DEFAULT false NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"target_at" timestamp with time zone,
	"requires" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "milestone_capabilities_milestone" ON "milestone_capabilities" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_content_target" ON "milestone_content" USING btree ("milestone_id","kind","target_id");--> statement-breakpoint
CREATE INDEX "milestone_content_capability" ON "milestone_content" USING btree ("capability_id");--> statement-breakpoint
CREATE INDEX "milestones_project" ON "milestones" USING btree ("project_id");