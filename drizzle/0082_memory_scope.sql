CREATE TABLE "memory_block_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"value" text NOT NULL,
	"change" text DEFAULT 'write' NOT NULL,
	"guarded" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entry_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"text" text NOT NULL,
	"links" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"scope_project_id" uuid,
	"change" text DEFAULT 'write' NOT NULL,
	"guarded" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- AIOS-53: blocks are addressed by id; labels are unique per scope (partial
-- unique indexes below). Existing blocks keep their label and become global.
ALTER TABLE "memory_blocks" DROP CONSTRAINT "memory_blocks_pkey";--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD CONSTRAINT "memory_blocks_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD COLUMN "scope_project_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD COLUMN "origin" text DEFAULT 'apos' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "scope_project_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "origin" text DEFAULT 'apos' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "links" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "embedding" vector;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_block_versions_version" ON "memory_block_versions" USING btree ("block_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entry_versions_version" ON "memory_entry_versions" USING btree ("entry_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_blocks_global_label" ON "memory_blocks" USING btree ("label") WHERE "memory_blocks"."scope_project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_blocks_scoped_label" ON "memory_blocks" USING btree ("scope_project_id","label") WHERE "memory_blocks"."scope_project_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_entries_scope" ON "memory_entries" USING btree ("scope_project_id");--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_description_len" CHECK (char_length("memory_entries"."description") <= 150);--> statement-breakpoint
-- A project's memory goes with the project. (set null would leak scoped rows
-- into global recall and context.) Not in the drizzle schema: core schema
-- doesn't import module tables.
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_scope_project_fk" FOREIGN KEY ("scope_project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD CONSTRAINT "memory_blocks_scope_project_fk" FOREIGN KEY ("scope_project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entry_versions" ADD CONSTRAINT "memory_entry_versions_entry_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."memory_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_block_versions" ADD CONSTRAINT "memory_block_versions_block_fk" FOREIGN KEY ("block_id") REFERENCES "public"."memory_blocks"("id") ON DELETE CASCADE;--> statement-breakpoint
-- R8: reserve the founder's cross-product working rules (global, empty; the
-- founder writes it in Settings → Memory).
INSERT INTO "memory_blocks" ("label", "description", "value", "char_limit")
VALUES ('founder-working-rules', 'The founder''s working rules that hold across every product: how to work, what to check, what never to do.', '', 1200)
ON CONFLICT DO NOTHING;
