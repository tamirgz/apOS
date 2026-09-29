"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/core/db/client";
import { createWorkItem, updateWorkItem } from "@/modules/tasks/core";
import { tasks } from "@/modules/tasks/schema";
import { features, featureRefOf, type FeatureStatus } from "./schema";

function revalidateProject(projectId: string) {
  revalidatePath(`/m/projects/${projectId}`);
  revalidatePath("/m/tasks");
  revalidatePath("/");
}

/** Rows for the project's Features section, in the user's chosen order. */
export async function listProjectFeatures(projectId: string) {
  return db
    .select()
    .from(features)
    .where(eq(features.projectId, projectId))
    .orderBy(asc(features.sortOrder), asc(features.createdAt));
}

export async function createFeature(
  projectId: string,
  name: string,
  opts: { startAt?: Date | null; targetAt?: Date | null } = {},
) {
  const trimmed = name.trim();
  if (!trimmed) return;
  // New features go to the end of the list, and start "planned" — the first
  // item that moves makes them active (tasks/core.ts syncFeatureStatus).
  const existing = await db
    .select({ sortOrder: features.sortOrder })
    .from(features)
    .where(eq(features.projectId, projectId));
  const nextOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder + 1), 0);
  const [row] = await db
    .insert(features)
    .values({ projectId, name: trimmed, sortOrder: nextOrder, status: "planned", startAt: opts.startAt ?? null, targetAt: opts.targetAt ?? null })
    .returning();
  revalidateProject(projectId);
  return row;
}

export async function updateFeature(
  id: string,
  projectId: string,
  patch: Partial<{ name: string; description: string | null; status: FeatureStatus; startAt: Date | null; targetAt: Date | null }>,
) {
  // A manual status wins over the automatic lifecycle until items move again.
  const statusPatch =
    patch.status === undefined
      ? {}
      : { status: patch.status, shippedAt: patch.status === "shipped" ? new Date() : null };
  await db
    .update(features)
    .set({
      ...(patch.name !== undefined && patch.name.trim() ? { name: patch.name.trim() } : {}),
      ...("description" in patch ? { description: patch.description?.trim() || null } : {}),
      ...("startAt" in patch ? { startAt: patch.startAt ?? null } : {}),
      ...("targetAt" in patch ? { targetAt: patch.targetAt ?? null } : {}),
      ...statusPatch,
      updatedAt: new Date(),
    })
    .where(eq(features.id, id));
  revalidateProject(projectId);
}

/** Delete a feature — its items survive as plain project items (detached). */
export async function deleteFeature(id: string, projectId: string) {
  await db
    .update(tasks)
    .set({ featureRef: null })
    .where(eq(tasks.featureRef, featureRefOf(id)));
  await db.delete(features).where(eq(features.id, id));
  revalidateProject(projectId);
}

/** Create an item directly inside a feature (rolls up to the project too). */
export async function createFeatureTask(
  featureId: string,
  projectId: string,
  title: string,
) {
  const trimmed = title.trim();
  if (!trimmed) return;
  await createWorkItem(
    db,
    { title: trimmed, projectRef: `projects:${projectId}`, featureRef: featureRefOf(featureId) },
    "user",
  );
  revalidateProject(projectId);
}

/** Move an item into a feature (featureId) or back out (null). */
export async function setTaskFeature(
  taskId: string,
  projectId: string,
  featureId: string | null,
) {
  await updateWorkItem(db, taskId, { featureRef: featureId ? featureRefOf(featureId) : null }, "user");
  revalidateProject(projectId);
}

/** Persist a new feature order (array of feature ids, top → bottom). */
export async function reorderFeatures(projectId: string, orderedIds: string[]) {
  await Promise.all(
    orderedIds.map((id, i) =>
      db.update(features).set({ sortOrder: i }).where(eq(features.id, id)),
    ),
  );
  revalidateProject(projectId);
}
