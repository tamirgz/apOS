CREATE TABLE "ui_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"path" text,
	"entity_ref" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ui_events_ts" ON "ui_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ui_events_event_ts" ON "ui_events" USING btree ("event","ts");