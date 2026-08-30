CREATE TABLE "agent_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"run_id" uuid,
	"event" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_audit_agent_created" ON "agent_audit" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_audit_created" ON "agent_audit" USING btree ("created_at");