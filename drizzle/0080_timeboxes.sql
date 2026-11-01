CREATE TABLE "timeboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"task_id" uuid,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'shallow' NOT NULL,
	"end_mode" text DEFAULT 'soft' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	"outcome" text,
	"google_event_id" text,
	"google_etag" text,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"origin" text DEFAULT 'apos' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "calendar_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "transparent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "timeboxes_start" ON "timeboxes" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "timeboxes_status_start" ON "timeboxes" USING btree ("status","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "timeboxes_google_event" ON "timeboxes" USING btree ("google_event_id");