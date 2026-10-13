-- Live work progress: any write to the work tracker NOTIFYs "work_changed"
-- (payload = table name) so open pages refresh their progress without a
-- reload — whoever wrote it (UI, apOS MCP, agents, jobs, Plane import, SQL).
-- Row-level, but Postgres folds identical NOTIFYs within one transaction, so
-- a bulk update still sends one event per table.
CREATE OR REPLACE FUNCTION notify_work_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('work_changed', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "tasks_work_changed" ON "tasks";
--> statement-breakpoint
CREATE TRIGGER "tasks_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "task_relations_work_changed" ON "task_relations";
--> statement-breakpoint
CREATE TRIGGER "task_relations_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "task_relations" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "features_work_changed" ON "features";
--> statement-breakpoint
CREATE TRIGGER "features_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "features" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cycles_work_changed" ON "cycles";
--> statement-breakpoint
CREATE TRIGGER "cycles_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "cycles" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "milestones_work_changed" ON "milestones";
--> statement-breakpoint
CREATE TRIGGER "milestones_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "milestones" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "milestone_capabilities_work_changed" ON "milestone_capabilities";
--> statement-breakpoint
CREATE TRIGGER "milestone_capabilities_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "milestone_capabilities" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "milestone_content_work_changed" ON "milestone_content";
--> statement-breakpoint
CREATE TRIGGER "milestone_content_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "milestone_content" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "projects_work_changed" ON "projects";
--> statement-breakpoint
CREATE TRIGGER "projects_work_changed" AFTER INSERT OR UPDATE OR DELETE ON "projects" FOR EACH ROW EXECUTE FUNCTION notify_work_changed();
