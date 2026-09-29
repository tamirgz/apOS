"use server";

import { asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/core/db/client";
import { recordUsage } from "@/core/usage";
import { features } from "@/modules/projects/schema";
import {
  addComment,
  createWorkItem,
  deleteWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemInput,
  type WorkItemPatch,
} from "./core";
import { tasks, type TaskStatus } from "./schema";

function revalidateWork(projectRef?: string | null) {
  revalidatePath("/");
  revalidatePath("/m/tasks");
  if (projectRef?.startsWith("projects:")) revalidatePath(`/m/projects/${projectRef.slice(9)}`);
}

export async function listTasks(status?: TaskStatus) {
  return listWorkItems(db, { statuses: status ? [status] : undefined });
}

export async function createTask(input: WorkItemInput) {
  const item = await createWorkItem(db, input, "user");
  recordUsage("work.create", { entityRef: `tasks:${item.id}` });
  revalidateWork(item.projectRef);
  return item;
}

export async function setTaskStatus(id: string, status: TaskStatus) {
  const item = await updateWorkItem(db, id, { status }, "user");
  revalidateWork(item?.projectRef);
  return item;
}

/** Board drag: new column and/or position in one write. */
export async function moveTask(id: string, status: TaskStatus, sortOrder: number) {
  const item = await updateWorkItem(db, id, { status, sortOrder }, "user");
  revalidateWork(item?.projectRef);
  return item;
}

export async function updateTask(id: string, patch: WorkItemPatch) {
  const item = await updateWorkItem(db, id, patch, "user");
  revalidateWork(item?.projectRef);
  return item;
}

export async function deleteTask(id: string) {
  await deleteWorkItem(db, id);
  revalidateWork();
}

export async function deleteDoneTasks() {
  const done = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.status, ["done", "cancelled"]));
  for (const t of done) await deleteWorkItem(db, t.id);
  revalidateWork();
}

/** Drawer payload: the item, its parent, sub-items, history and the project's features. */
export async function loadWorkItem(id: string) {
  const data = await getWorkItem(db, id);
  if (!data) return null;
  const projectId = data.item.projectRef?.startsWith("projects:") ? data.item.projectRef.slice(9) : null;
  const projectFeatures = projectId
    ? await db
        .select({ id: features.id, name: features.name, status: features.status })
        .from(features)
        .where(eq(features.projectId, projectId))
        .orderBy(asc(features.sortOrder))
    : [];
  return { ...data, features: projectFeatures };
}

export async function addTaskComment(id: string, body: string) {
  const row = await addComment(db, id, body, "user");
  recordUsage("work.comment", { entityRef: `tasks:${id}` });
  return row;
}
