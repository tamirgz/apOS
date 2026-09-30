"use server";

import { asc, eq, inArray, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import { recordUsage } from "@/core/usage";
import { features } from "@/modules/projects/schema";
import {
  addComment,
  addRelation,
  createWorkItem,
  findByIdentifier,
  removeRelation,
  deleteWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemInput,
  type RelationSide,
  type WorkItemPatch,
} from "./core";
import { createCycle, cycleStatus, deleteCycle, rollOverCycle, updateCycle } from "./cycles";
import { delegateFeature, delegateWorkItem } from "./delegate";
import { PLANE_STATUS_KEY, type PlaneImportStatus } from "./plane/import";
import { cycles, tasks, workViews, type TaskStatus, type WorkViewFilters } from "./schema";

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
  // Cycles you can plan into: this project's + cross-project ones, not finished
  // (plus the item's own, so a completed cycle still shows its name).
  const cycleRows = await db
    .select({ id: cycles.id, name: cycles.name, startsAt: cycles.startsAt, endsAt: cycles.endsAt })
    .from(cycles)
    .where(projectId ? or(isNull(cycles.projectId), eq(cycles.projectId, projectId)) : isNull(cycles.projectId))
    .orderBy(asc(cycles.startsAt));
  const now = Date.now();
  const cycleOptions = cycleRows
    .filter((c) => c.id === data.item.cycleId || cycleStatus(c, now) !== "completed")
    .map((c) => ({ id: c.id, name: c.name, status: cycleStatus(c, now) }));
  return { ...data, features: projectFeatures, cycles: cycleOptions };
}

export async function addTaskComment(id: string, body: string) {
  const row = await addComment(db, id, body, "user");
  recordUsage("work.comment", { entityRef: `tasks:${id}` });
  return row;
}

// ── relations ──────────────────────────────────────────────────────────────

/** Relate this item to another, typed as an identifier ("GL-4"). */
export async function relateTask(id: string, side: RelationSide, identifier: string) {
  const other = await findByIdentifier(db, identifier);
  if (!other) return { ok: false as const, error: `No work item ${identifier.trim().toUpperCase()}` };
  await addRelation(db, id, side, other.id, "user");
  revalidateWork();
  return { ok: true as const };
}

export async function unrelateTask(relationId: string) {
  await removeRelation(db, relationId);
  revalidateWork();
}

// ── cycles ─────────────────────────────────────────────────────────────────

const toDate = (s: string) => new Date(`${s}T00:00:00`);

export async function createCycleAction(input: { name: string; startsAt: string; endsAt: string; projectId?: string | null }) {
  const row = await createCycle(db, {
    name: input.name,
    startsAt: toDate(input.startsAt),
    endsAt: toDate(input.endsAt),
    projectId: input.projectId ?? null,
  });
  recordUsage("work.cycle.create");
  revalidateWork(input.projectId ? `projects:${input.projectId}` : null);
  return row;
}

export async function updateCycleAction(id: string, patch: { name?: string; startsAt?: string; endsAt?: string }) {
  await updateCycle(db, id, {
    name: patch.name,
    startsAt: patch.startsAt ? toDate(patch.startsAt) : undefined,
    endsAt: patch.endsAt ? toDate(patch.endsAt) : undefined,
  });
  revalidateWork();
}

export async function deleteCycleAction(id: string) {
  await deleteCycle(db, id);
  revalidateWork();
}

export async function rollOverCycleAction(fromId: string, toId: string | null) {
  const n = await rollOverCycle(db, fromId, toId);
  revalidateWork();
  return n;
}

// ── Workbench delegation ───────────────────────────────────────────────────

export async function delegateTask(id: string, extra?: string) {
  const wb = await delegateWorkItem(db, id, "user", extra);
  recordUsage("work.delegate", { entityRef: `tasks:${id}` });
  revalidateWork();
  revalidatePath("/m/workbench");
  return { id: wb.id };
}

export async function delegateFeatureAction(featureId: string, extra?: string) {
  const wb = await delegateFeature(db, featureId, "user", extra);
  recordUsage("work.delegate", { entityRef: `features:${featureId}` });
  revalidateWork();
  revalidatePath("/m/workbench");
  return { id: wb.id };
}

// ── Plane import ───────────────────────────────────────────────────────────

export async function planeImportState(): Promise<{ configured: boolean; status: PlaneImportStatus | null }> {
  const [workspace, key, raw] = await Promise.all([
    getSetting("plane_workspace"),
    getSetting("plane_api_key"),
    getSetting(PLANE_STATUS_KEY),
  ]);
  let status: PlaneImportStatus | null = null;
  try {
    status = raw ? (JSON.parse(raw) as PlaneImportStatus) : null;
  } catch {
    status = null;
  }
  return { configured: !!workspace?.trim() && !!key?.trim(), status };
}

/** Queue a preview (read-only) or an import of the chosen Plane projects on the worker. */
export async function startPlaneImport(mode: "preview" | "import", projectIds?: string[]) {
  const { status } = await planeImportState();
  // A run that stopped reporting for 10 minutes is dead (worker restart) — allow a new one.
  const lastBeat = new Date(status?.updatedAt ?? status?.startedAt ?? 0).getTime();
  const stale = status?.state === "running" && Date.now() - lastBeat > 10 * 60_000;
  if (status?.state === "running" && !stale) return { ok: false as const, error: "A Plane import is already running" };
  recordUsage(`work.plane.${mode}`);
  const now = new Date().toISOString();
  const queued: PlaneImportStatus = { state: "running", mode, startedAt: now, updatedAt: now, step: "queued for the worker", log: [] };
  await setSetting(PLANE_STATUS_KEY, JSON.stringify(queued));
  await sql.notify("plane_import", JSON.stringify({ mode, projectIds }));
  return { ok: true as const };
}

// ── saved views ────────────────────────────────────────────────────────────

/** Save the current filters as a named view (on a project page, or on all work when projectId is null). */
export async function saveWorkView(projectId: string | null, name: string, filters: WorkViewFilters) {
  const clean = name.trim().slice(0, 60);
  if (!clean) return { ok: false as const, error: "A view needs a name" };
  const kept = Object.fromEntries(Object.entries(filters).filter(([, v]) => typeof v === "string" && v)) as WorkViewFilters;
  const [row] = await db.insert(workViews).values({ projectId, name: clean, filters: kept }).returning();
  revalidateWork(projectId ? `projects:${projectId}` : null);
  return row;
}

export async function deleteWorkView(id: string) {
  const [row] = await db.delete(workViews).where(eq(workViews.id, id)).returning({ projectId: workViews.projectId });
  revalidateWork(row?.projectId ? `projects:${row.projectId}` : null);
}
