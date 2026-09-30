import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { searchIndex } from "@/core/db/schema/search-index";
import type { ContentInfo, MilestoneBundle } from "./milestone-scope";
import { milestoneCapabilities, milestoneContent, milestones } from "./schema";

/**
 * Every milestone of a project (or of all projects), with its capabilities and
 * content rows. Entity content gets its live title and link from the search
 * index, falling back to the label snapshotted when it was added.
 */
export async function loadMilestoneBundle(db: Db, projectId?: string): Promise<MilestoneBundle> {
  const ms = await db
    .select()
    .from(milestones)
    .where(projectId ? eq(milestones.projectId, projectId) : undefined)
    .orderBy(asc(milestones.sortOrder), asc(milestones.createdAt));
  if (!ms.length) return { milestones: [], capabilities: [], content: [] };
  const ids = ms.map((m) => m.id);
  const [caps, rows] = await Promise.all([
    db.select().from(milestoneCapabilities).where(inArray(milestoneCapabilities.milestoneId, ids)),
    db.select().from(milestoneContent).where(inArray(milestoneContent.milestoneId, ids)).orderBy(asc(milestoneContent.createdAt)),
  ]);
  const entityIds = [...new Set(rows.filter((r) => r.kind === "entity").map((r) => r.targetId))];
  const hits = entityIds.length
    ? await db
        .select({ kind: searchIndex.kind, sourceId: searchIndex.sourceId, title: searchIndex.title, href: searchIndex.href })
        .from(searchIndex)
        .where(inArray(searchIndex.sourceId, entityIds))
    : [];
  const hitOf = new Map(hits.map((h) => [`${h.kind}:${h.sourceId}`, h]));
  const content: ContentInfo[] = rows.map((r) => {
    const h = r.kind === "entity" ? hitOf.get(`${r.entityKind}:${r.targetId}`) : undefined;
    return {
      id: r.id,
      milestoneId: r.milestoneId,
      capabilityId: r.capabilityId,
      kind: r.kind,
      targetId: r.targetId,
      entityKind: r.entityKind,
      label: h?.title ?? r.label,
      href: h?.href ?? null,
      exclude: r.exclude,
      done: r.done,
      doneAt: r.doneAt,
      createdAt: r.createdAt,
    };
  });
  return {
    milestones: ms.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      description: m.description,
      status: m.status,
      targetAt: m.targetAt,
      requires: m.requires,
      criteria: m.criteria,
      sortOrder: m.sortOrder,
      doneAt: m.doneAt,
      createdAt: m.createdAt,
    })),
    capabilities: caps.map((c) => ({ id: c.id, milestoneId: c.milestoneId, name: c.name, description: c.description, sortOrder: c.sortOrder })),
    content,
  };
}

/** A capability of the milestone by name (case-insensitive), created at the end when new. */
export async function ensureCapability(db: Db, milestoneId: string, name: string): Promise<string> {
  const clean = name.trim();
  const [hit] = await db
    .select({ id: milestoneCapabilities.id })
    .from(milestoneCapabilities)
    .where(and(eq(milestoneCapabilities.milestoneId, milestoneId), sql`lower(${milestoneCapabilities.name}) = ${clean.toLowerCase()}`));
  if (hit) return hit.id;
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${milestoneCapabilities.sortOrder}) + 1, 0)` })
    .from(milestoneCapabilities)
    .where(eq(milestoneCapabilities.milestoneId, milestoneId));
  const [row] = await db
    .insert(milestoneCapabilities)
    .values({ milestoneId, name: clean, sortOrder: Number(next) })
    .returning({ id: milestoneCapabilities.id });
  return row.id;
}

/**
 * Add content rows, or update the ones already there (capability, exclude,
 * done) — so re-adding with a capability moves content between capabilities.
 */
export async function upsertContent(
  db: Db,
  milestoneId: string,
  rows: { kind: ContentInfo["kind"]; targetId: string; entityKind?: string | null; label?: string | null }[],
  opts: { capabilityId?: string | null; exclude?: boolean; done?: boolean },
): Promise<number> {
  if (!rows.length) return 0;
  const now = new Date();
  const values = rows.map((r) => ({
    milestoneId,
    kind: r.kind,
    targetId: r.targetId,
    entityKind: r.entityKind ?? null,
    label: r.label ?? null,
    capabilityId: opts.capabilityId ?? null,
    exclude: opts.exclude ?? false,
    done: opts.done ?? false,
    doneAt: opts.done ? now : null,
  }));
  const set: Record<string, unknown> = {};
  if (opts.capabilityId !== undefined) set.capabilityId = sql`excluded.capability_id`;
  if (opts.exclude !== undefined) set.exclude = sql`excluded.exclude`;
  if (opts.done !== undefined) {
    set.done = sql`excluded.done`;
    set.doneAt = sql`case when excluded.done and not ${milestoneContent.done} then excluded.done_at when excluded.done then ${milestoneContent.doneAt} else null end`;
  }
  const q = db.insert(milestoneContent).values(values);
  const res = Object.keys(set).length
    ? await q.onConflictDoUpdate({ target: [milestoneContent.milestoneId, milestoneContent.kind, milestoneContent.targetId], set }).returning({ id: milestoneContent.id })
    : await q.onConflictDoNothing().returning({ id: milestoneContent.id });
  await db.update(milestones).set({ updatedAt: now }).where(eq(milestones.id, milestoneId));
  return res.length;
}

export async function removeContent(db: Db, milestoneId: string, rows: { kind: ContentInfo["kind"]; targetId: string }[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const out = await db
      .delete(milestoneContent)
      .where(and(eq(milestoneContent.milestoneId, milestoneId), eq(milestoneContent.kind, r.kind), eq(milestoneContent.targetId, r.targetId)))
      .returning({ id: milestoneContent.id });
    n += out.length;
  }
  return n;
}

/** Delete a milestone with its capabilities and content rows — never the work it points at. */
export async function deleteMilestone(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(milestoneContent).where(eq(milestoneContent.milestoneId, id));
    // Other milestones that contained or required this one drop the reference.
    await tx.delete(milestoneContent).where(and(eq(milestoneContent.kind, "milestone"), eq(milestoneContent.targetId, id)));
    await tx.execute(sql`update milestones set requires = array_remove(requires, ${id}::uuid) where ${id}::uuid = any(requires)`);
    await tx.delete(milestoneCapabilities).where(eq(milestoneCapabilities.milestoneId, id));
    await tx.delete(milestones).where(eq(milestones.id, id));
  });
}
