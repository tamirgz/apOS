/**
 * Which project's memory a Workbench run loads (AIOS-53 R9): its task's first
 * project ref ("projects:<uuid>"). A task with no project gets global memory only.
 */
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { taskAttempts, workbenchTasks } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The project id in the first "projects:<uuid>" ref, or null. */
export function projectFromRefs(refs: string[] | null | undefined): string | null {
  for (const ref of refs ?? []) {
    const [kind, id] = ref.split(":");
    if (kind === "projects" && id && UUID.test(id)) return id;
  }
  return null;
}

export async function memoryProjectForTask(taskId: string): Promise<string | null> {
  const [t] = await db
    .select({ refs: workbenchTasks.projectRefs })
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId))
    .limit(1);
  return projectFromRefs(t?.refs);
}

export async function memoryProjectForAttempt(attemptId: string): Promise<string | null> {
  const [a] = await db
    .select({ taskId: taskAttempts.taskId })
    .from(taskAttempts)
    .where(eq(taskAttempts.id, attemptId))
    .limit(1);
  return a ? memoryProjectForTask(a.taskId) : null;
}
