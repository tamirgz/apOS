"use server";

import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, notInArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/core/db/client";
import { searchIndex } from "@/core/db/schema/search-index";
import { features } from "@/modules/projects/schema";
import type { ContentInfo } from "./milestone-scope";
import { deleteMilestone, ensureCapability, removeContent, upsertContent } from "./milestones";
import { milestoneCapabilities, milestones, tasks, type MilestoneCriterion, type MilestoneStatus } from "./schema";

function revalidate(projectId: string) {
  revalidatePath(`/m/projects/${projectId}`);
  revalidatePath("/m/tasks");
}

/** A failure the UI shows as is — thrown messages are redacted in production builds. */
const fail = (error: string) => ({ ok: false as const, error });
const GONE = fail("That milestone no longer exists");

async function milestoneOf(id: string) {
  const [m] = await db.select().from(milestones).where(eq(milestones.id, id));
  return m ?? null;
}

export async function createMilestoneAction(projectId: string, name: string) {
  const clean = name.trim();
  if (!clean) return fail("A milestone needs a name");
  const existing = await db.select({ name: milestones.name, sortOrder: milestones.sortOrder }).from(milestones).where(eq(milestones.projectId, projectId));
  if (existing.some((m) => m.name.toLowerCase() === clean.toLowerCase())) return fail(`This project already has a milestone "${clean}"`);
  const [row] = await db
    .insert(milestones)
    .values({ projectId, name: clean, sortOrder: existing.reduce((n, m) => Math.max(n, m.sortOrder + 1), 0) })
    .returning({ id: milestones.id });
  revalidate(projectId);
  return { ok: true as const, id: row.id };
}

export async function updateMilestoneAction(
  id: string,
  patch: Partial<{ name: string; description: string | null; status: MilestoneStatus; targetAt: Date | null; requires: string[] }>,
) {
  const m = await milestoneOf(id);
  if (!m) return GONE;
  const set: Partial<typeof milestones.$inferInsert> = {};
  if (patch.name !== undefined) {
    const clean = patch.name.trim();
    if (!clean) return fail("A milestone needs a name");
    const [clash] = await db
      .select({ id: milestones.id })
      .from(milestones)
      .where(and(eq(milestones.projectId, m.projectId), sql`lower(${milestones.name}) = ${clean.toLowerCase()}`, sql`${milestones.id} <> ${id}`));
    if (clash) return fail(`This project already has a milestone "${clean}"`);
    set.name = clean;
  }
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.doneAt = patch.status === "done" ? new Date() : null;
  }
  if (patch.targetAt !== undefined) set.targetAt = patch.targetAt;
  if (patch.requires !== undefined) {
    const ids = [...new Set(patch.requires.filter((r) => r !== id))];
    const own = ids.length
      ? await db.select({ id: milestones.id }).from(milestones).where(and(inArray(milestones.id, ids), eq(milestones.projectId, m.projectId)))
      : [];
    set.requires = own.map((r) => r.id);
  }
  await db.update(milestones).set({ ...set, updatedAt: new Date() }).where(eq(milestones.id, id));
  revalidate(m.projectId);
  return { ok: true as const };
}

export async function deleteMilestoneAction(id: string) {
  const m = await milestoneOf(id);
  if (!m) return GONE;
  await deleteMilestone(db, id);
  revalidate(m.projectId);
  return { ok: true as const };
}

type Row = { kind: ContentInfo["kind"]; targetId: string; entityKind?: string | null; label?: string | null };

/** Modules and items must be the milestone's project's; nested milestones too, and never itself. */
async function checkRows(m: { id: string; projectId: string }, rows: Row[]) {
  const ids = (k: Row["kind"]) => rows.filter((r) => r.kind === k).map((r) => r.targetId);
  const [mods, items, ms] = await Promise.all([
    ids("module").length ? db.select({ id: features.id }).from(features).where(and(inArray(features.id, ids("module")), eq(features.projectId, m.projectId))) : [],
    ids("item").length
      ? db.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, ids("item")), eq(tasks.projectRef, `projects:${m.projectId}`)))
      : [],
    ids("milestone").length
      ? db.select({ id: milestones.id }).from(milestones).where(and(inArray(milestones.id, ids("milestone")), eq(milestones.projectId, m.projectId)))
      : [],
  ]);
  const ok = new Set([...mods, ...items, ...ms].map((r) => r.id));
  const bad = rows.filter((r) => r.kind !== "entity" && (!ok.has(r.targetId) || (r.kind === "milestone" && r.targetId === m.id)));
  return bad.length ? "Some of that content isn't in this milestone's project" : null;
}

export async function addMilestoneContent(
  id: string,
  rows: Row[],
  opts: { capabilityId?: string | null; capabilityName?: string; exclude?: boolean; done?: boolean } = {},
) {
  const m = await milestoneOf(id);
  if (!m) return GONE;
  if (!rows.length) return { ok: true as const, n: 0 };
  if (opts.exclude && rows.some((r) => r.kind === "milestone" || r.kind === "entity")) return fail("Only modules and items can be left out of scope");
  const bad = await checkRows(m, rows);
  if (bad) return fail(bad);
  const capabilityId = opts.capabilityName?.trim() ? await ensureCapability(db, id, opts.capabilityName) : opts.capabilityId;
  const n = await upsertContent(db, id, rows, { capabilityId, exclude: opts.exclude, done: opts.done });
  revalidate(m.projectId);
  return { ok: true as const, n };
}

export async function removeMilestoneContent(id: string, rows: { kind: ContentInfo["kind"]; targetId: string }[]) {
  const m = await milestoneOf(id);
  if (!m) return GONE;
  const n = await removeContent(db, id, rows);
  revalidate(m.projectId);
  return { ok: true as const, n };
}

export async function saveCapability(milestoneId: string, capId: string | null, patch: { name?: string; description?: string | null }) {
  const m = await milestoneOf(milestoneId);
  if (!m) return GONE;
  if (!capId) {
    if (!patch.name?.trim()) return fail("A capability needs a name");
    const id = await ensureCapability(db, milestoneId, patch.name);
    revalidate(m.projectId);
    return { ok: true as const, id };
  }
  await db
    .update(milestoneCapabilities)
    .set({
      ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
    })
    .where(and(eq(milestoneCapabilities.id, capId), eq(milestoneCapabilities.milestoneId, milestoneId)));
  revalidate(m.projectId);
  return { ok: true as const, id: capId };
}

/** Delete a capability; its content stays in the milestone, ungrouped. */
export async function deleteCapability(milestoneId: string, capId: string) {
  const m = await milestoneOf(milestoneId);
  if (!m) return GONE;
  await db.execute(sql`update milestone_content set capability_id = null where capability_id = ${capId} and milestone_id = ${milestoneId}`);
  await db.delete(milestoneCapabilities).where(and(eq(milestoneCapabilities.id, capId), eq(milestoneCapabilities.milestoneId, milestoneId)));
  revalidate(m.projectId);
  return { ok: true as const };
}

export async function setMilestoneCriteria(id: string, next: { id?: string; text: string; done: boolean }[]) {
  const m = await milestoneOf(id);
  if (!m) return GONE;
  const criteria: MilestoneCriterion[] = next
    .filter((c) => c.text.trim())
    .map((c) => ({ id: c.id ?? randomUUID(), text: c.text.trim(), done: c.done }));
  await db.update(milestones).set({ criteria, updatedAt: new Date() }).where(eq(milestones.id, id));
  revalidate(m.projectId);
  return { ok: true as const };
}

/** Kinds that aren't deliverables of their own (work items and modules have their own tabs in the picker). */
const NOT_ENTITIES = ["task", "feature", "project", "memory", "attention", "notification", "ask"];

/** Anything else in apOS a milestone can hold as one deliverable — a note, a doc, a file, a run… */
export async function searchMilestoneEntities(q: string) {
  const needle = q.trim();
  if (needle.length < 2) return [];
  return db
    .select({ kind: searchIndex.kind, id: searchIndex.sourceId, title: searchIndex.title })
    .from(searchIndex)
    .where(and(notInArray(searchIndex.kind, NOT_ENTITIES), ilike(searchIndex.title, `%${needle}%`)))
    .orderBy(desc(searchIndex.updatedAt))
    .limit(20);
}
