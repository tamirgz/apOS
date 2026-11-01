CREATE TABLE "cycle_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"left_to" uuid,
	"left_reason" text,
	"source" text DEFAULT 'live' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cycles" ADD COLUMN "history_complete" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "cycle_membership_cycle" ON "cycle_membership" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "cycle_membership_task" ON "cycle_membership" USING btree ("task_id");--> statement-breakpoint
-- Every change to tasks.cycle_id closes the item's open stay and opens one in
-- the cycle it joins — whoever wrote it (UI, apOS MCP, agents, jobs, import,
-- SQL). A deleted item takes its stays with it.
CREATE OR REPLACE FUNCTION track_cycle_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM cycle_membership WHERE task_id = OLD.id;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.cycle_id IS NOT DISTINCT FROM OLD.cycle_id THEN
      RETURN NULL;
    END IF;
    UPDATE cycle_membership SET left_at = now(), left_to = NEW.cycle_id
      WHERE task_id = NEW.id AND left_at IS NULL;
  END IF;
  IF NEW.cycle_id IS NOT NULL THEN
    INSERT INTO cycle_membership (cycle_id, task_id, joined_at) VALUES (NEW.cycle_id, NEW.id, now());
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "tasks_cycle_membership" ON "tasks";
--> statement-breakpoint
CREATE TRIGGER "tasks_cycle_membership" AFTER INSERT OR UPDATE OF cycle_id OR DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION track_cycle_membership();
