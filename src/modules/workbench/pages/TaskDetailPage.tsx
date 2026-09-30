import { notFound } from "next/navigation";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { listProjectOptions } from "@/modules/projects/queries";
import { getTaskDetail } from "../queries";
import { TaskDetailView, type LinkedWorkItem } from "../components/TaskDetail";

/** Work items this run was handed off from (task_links kind "workbench"). */
async function linkedWorkItems(runId: string): Promise<LinkedWorkItem[]> {
  const [{ db }, { and, eq, inArray }, { taskLinks, tasks }, { withIdentifiers }, { plainTitle }] =
    await Promise.all([
      import("@/core/db/client"),
      import("drizzle-orm"),
      import("@/modules/tasks/schema"),
      import("@/modules/tasks/core"),
      import("@/modules/tasks/states"),
    ]);
  const links = await db
    .select({ taskId: taskLinks.taskId })
    .from(taskLinks)
    .where(and(eq(taskLinks.kind, "workbench"), eq(taskLinks.ref, runId)));
  if (!links.length) return [];
  const rows = await withIdentifiers(
    db,
    await db.select().from(tasks).where(inArray(tasks.id, links.map((l) => l.taskId))),
  );
  return rows.map((t) => ({
    id: t.id,
    identifier: t.identifier,
    title: plainTitle(t.title),
    status: t.status,
  }));
}

export async function TaskDetailPage({ params }: ModuleRouteProps) {
  const [detail, projectOptions, workItems] = await Promise.all([
    getTaskDetail(params[0]),
    listProjectOptions(),
    linkedWorkItems(params[0]).catch(() => []),
  ]);
  if (!detail) notFound();
  return <TaskDetailView detail={detail} projectOptions={projectOptions} workItems={workItems} />;
}
