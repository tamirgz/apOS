/**
 * Work items — the ONE write path. UI server actions, agent tools, the Plane
 * importer and the repo watcher all go through here, so numbering, activity
 * history and feature lifecycle can't drift between callers.
 *
 * Worker-safe: no "use server", no revalidatePath, db passed in.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { features, projects } from "@/modules/projects/schema";
import {
  cycles,
  isClosed,
  taskActivity,
  taskLinks,
  taskRelations,
  tasks,
  workCounters,
  type LinkKind,
  type RelationKind,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./schema";
import { deriveKey, formatIdentifier, LOOSE_KEY, LOOSE_SCOPE, parseIdentifier } from "./keys";
import { RELATION_SIDE_LABEL, STATUS_META, type RelationSide } from "./states";

export type { RelationSide };

/** "user" | "agent:<name>" | "system:<source>" */
export type Actor = string;

export type WorkItem = Task & { identifier: string | null };

export interface WorkItemInput {
  title: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueAt?: Date | null;
  startAt?: Date | null;
  projectRef?: string | null;
  featureRef?: string | null;
  parentId?: string | null;
  estimate?: number | null;
  labels?: string[];
  externalRef?: string | null;
  cycleId?: string | null;
  sortOrder?: number;
  /** For imports that carry their own history. */
  createdAt?: Date;
  completedAt?: Date | null;
}

export type WorkItemPatch = Partial<Omit<WorkItemInput, "externalRef" | "createdAt">>;

const projectIdOf = (ref: string | null | undefined) =>
  ref?.startsWith("projects:") ? ref.slice("projects:".length) : null;
const featureIdOf = (ref: string | null | undefined) =>
  ref?.startsWith("features:") ? ref.slice("features:".length) : null;

export const cleanLabels = (labels: string[] | undefined) =>
  [...new Set((labels ?? []).map((l) => l.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))].slice(0, 12);

// ── keys & numbers ─────────────────────────────────────────────────────────

/** The project's identifier key, deriving + persisting one on first need. */
export async function ensureProjectKey(db: Db, projectId: string): Promise<string | null> {
  const [p] = await db
    .select({ key: projects.key, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!p) return null;
  if (p.key) return p.key;
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = new Set(
      (await db.select({ key: projects.key }).from(projects)).map((r) => r.key).filter((k): k is string => !!k),
    );
    const key = deriveKey(p.name, taken);
    try {
      const [row] = await db
        .update(projects)
        .set({ key })
        .where(and(eq(projects.id, projectId), isNull(projects.key)))
        .returning({ key: projects.key });
      if (row?.key) return row.key;
      const [again] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
      return again?.key ?? null;
    } catch {
      // unique violation — another writer took the key; retry with a fresh `taken` set
    }
  }
  return null;
}

/** Atomically allocate the next number in a scope (a project id, or "loose"). */
export async function nextNumber(db: Db, scope: string): Promise<number> {
  const [row] = await db
    .insert(workCounters)
    .values({ scope, value: 1 })
    .onConflictDoUpdate({ target: workCounters.scope, set: { value: sql`${workCounters.value} + 1` } })
    .returning({ value: workCounters.value });
  return row.value;
}

async function allocateNumber(db: Db, projectRef: string | null | undefined): Promise<number> {
  const pid = projectIdOf(projectRef);
  if (pid) await ensureProjectKey(db, pid);
  return nextNumber(db, pid ?? LOOSE_SCOPE);
}

/** projectId → key, for rendering identifiers. */
export async function projectKeyMap(db: Db): Promise<Map<string, string>> {
  const rows = await db.select({ id: projects.id, key: projects.key }).from(projects);
  return new Map(rows.filter((r) => r.key).map((r) => [r.id, r.key!]));
}

export function identifierOf(t: Pick<Task, "projectRef" | "number">, keys: Map<string, string>): string | null {
  const pid = projectIdOf(t.projectRef);
  return formatIdentifier(pid ? (keys.get(pid) ?? "?") : LOOSE_KEY, t.number);
}

export async function withIdentifiers(db: Db, rows: Task[]): Promise<WorkItem[]> {
  const keys = await projectKeyMap(db);
  return rows.map((t) => ({ ...t, identifier: identifierOf(t, keys) }));
}

/** Look up an item by its human identifier ("ETHOS-12", "T-4"). */
export async function findByIdentifier(db: Db, identifier: string): Promise<Task | null> {
  const id = parseIdentifier(identifier);
  if (!id) return null;
  if (id.key === LOOSE_KEY) {
    const [t] = await db
      .select()
      .from(tasks)
      .where(and(isNull(tasks.projectRef), eq(tasks.number, id.number)));
    return t ?? null;
  }
  const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.key, id.key));
  if (!p) return null;
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectRef, `projects:${p.id}`), eq(tasks.number, id.number)));
  return t ?? null;
}

// ── feature lifecycle ──────────────────────────────────────────────────────

/**
 * Re-derive a feature's status from its items (see FEATURE_STATUSES). Manual
 * states (paused / cancelled) are left alone.
 */
export async function syncFeatureStatus(db: Db, featureRef: string | null | undefined): Promise<void> {
  const fid = featureIdOf(featureRef);
  if (!fid) return;
  const [f] = await db.select().from(features).where(eq(features.id, fid));
  if (!f || f.status === "paused" || f.status === "cancelled") return;
  const items = await db
    .select({ status: tasks.status, completedAt: tasks.completedAt })
    .from(tasks)
    .where(eq(tasks.featureRef, `features:${fid}`));
  const open = items.filter((t) => !isClosed(t.status));
  let next = f.status;
  let shippedAt = f.shippedAt;
  if (items.length > 0 && open.length === 0) {
    next = "shipped";
    shippedAt ??= new Date();
  } else if (f.status === "shipped") {
    next = "active";
    shippedAt = null;
  } else if (f.status === "planned" && items.some((t) => t.status !== "backlog" && t.status !== "todo")) {
    next = "active";
  }
  if (next !== f.status || shippedAt !== f.shippedAt) {
    await db.update(features).set({ status: next, shippedAt, updatedAt: new Date() }).where(eq(features.id, fid));
  }
}

// ── activity ───────────────────────────────────────────────────────────────

const day = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function displayValue(db: Db, field: string, v: unknown): Promise<string | null> {
  if (v === null || v === undefined || v === "") return null;
  switch (field) {
    case "status":
      return STATUS_META[v as TaskStatus]?.label ?? String(v);
    case "dueAt":
    case "startAt":
      return day(v as Date);
    case "labels":
      return (v as string[]).length ? (v as string[]).join(", ") : null;
    case "projectRef": {
      const pid = projectIdOf(v as string);
      if (!pid) return null;
      const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, pid));
      return p?.name ?? null;
    }
    case "featureRef": {
      const fid = featureIdOf(v as string);
      if (!fid) return null;
      const [f] = await db.select({ name: features.name }).from(features).where(eq(features.id, fid));
      return f?.name ?? null;
    }
    case "cycleId": {
      const [c] = await db.select({ name: cycles.name }).from(cycles).where(eq(cycles.id, v as string));
      return c?.name ?? null;
    }
    case "parentId": {
      const [t] = await db.select().from(tasks).where(eq(tasks.id, v as string));
      if (!t) return null;
      return identifierOf(t, await projectKeyMap(db)) ?? t.title;
    }
    default:
      return String(v);
  }
}

const TRACKED: (keyof WorkItemPatch)[] = [
  "title",
  "status",
  "priority",
  "dueAt",
  "startAt",
  "projectRef",
  "featureRef",
  "parentId",
  "cycleId",
  "estimate",
  "labels",
  "notes",
];

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return day(a as Date) === day(b as Date);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? null) === (b ?? null);
}

export async function listActivity(db: Db, taskId: string) {
  return db
    .select()
    .from(taskActivity)
    .where(eq(taskActivity.taskId, taskId))
    .orderBy(asc(taskActivity.createdAt));
}

// ── writes ─────────────────────────────────────────────────────────────────

async function assertParent(db: Db, id: string | null, parentId: string | null | undefined) {
  if (!parentId) return;
  if (parentId === id) throw new Error("An item can't be its own parent");
  let cur: string | null = parentId;
  for (let depth = 0; cur && depth < 20; depth++) {
    if (cur === id) throw new Error("That would make a loop of sub-items");
    const [row] = await db.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, cur));
    if (!row) throw new Error("Parent item not found");
    cur = row.parentId;
  }
}

export async function createWorkItem(db: Db, input: WorkItemInput, actor: Actor): Promise<WorkItem> {
  const title = input.title.trim();
  if (!title) throw new Error("Title is required");
  let projectRef = input.projectRef ?? null;
  let featureRef = input.featureRef ?? null;
  if (input.parentId) {
    await assertParent(db, null, input.parentId);
    const [parent] = await db.select().from(tasks).where(eq(tasks.id, input.parentId));
    projectRef ??= parent?.projectRef ?? null;
    featureRef ??= parent?.featureRef ?? null;
  }
  if (featureRef && !projectRef) {
    const [f] = await db.select({ projectId: features.projectId }).from(features).where(eq(features.id, featureIdOf(featureRef)!));
    if (f) projectRef = `projects:${f.projectId}`;
  }
  const status = input.status ?? "todo";
  const number = await allocateNumber(db, projectRef);
  const [row] = await db
    .insert(tasks)
    .values({
      title,
      notes: input.notes?.trim() || null,
      status,
      priority: input.priority ?? "medium",
      dueAt: input.dueAt ?? null,
      startAt: input.startAt ?? null,
      projectRef,
      featureRef,
      parentId: input.parentId ?? null,
      estimate: input.estimate ?? null,
      labels: cleanLabels(input.labels),
      externalRef: input.externalRef ?? null,
      cycleId: input.cycleId ?? null,
      sortOrder: input.sortOrder ?? Date.now() / 1000,
      number,
      createdAt: input.createdAt ?? new Date(),
      updatedAt: new Date(),
      completedAt: isClosed(status) ? (input.completedAt ?? new Date()) : null,
    })
    .returning();
  await db.insert(taskActivity).values({ taskId: row.id, actor, kind: "created" });
  await syncFeatureStatus(db, featureRef);
  const [item] = await withIdentifiers(db, [row]);
  return item;
}

export async function updateWorkItem(
  db: Db,
  id: string,
  patch: WorkItemPatch,
  actor: Actor,
): Promise<WorkItem | null> {
  const [cur] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!cur) return null;

  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "title") {
      const t = String(v).trim();
      if (!t) throw new Error("Title is required");
      next.title = t;
    } else if (k === "notes") next.notes = (v as string | null)?.trim() || null;
    else if (k === "labels") next.labels = cleanLabels(v as string[]);
    else next[k] = v;
  }
  if ("parentId" in next) await assertParent(db, id, next.parentId as string | null);

  // Moving projects: new number in the new scope; a feature from the old
  // project can't come along.
  if ("projectRef" in next && !same(next.projectRef, cur.projectRef)) {
    next.number = await allocateNumber(db, next.projectRef as string | null);
    if (!("featureRef" in next)) next.featureRef = null;
  }
  if ("status" in next && next.status !== cur.status) {
    const closedNow = isClosed(next.status as TaskStatus);
    if (closedNow && !isClosed(cur.status)) next.completedAt = patch.completedAt ?? new Date();
    if (!closedNow) next.completedAt = null;
  }

  const changed = TRACKED.filter((f) => f in next && !same(next[f], cur[f as keyof Task]));
  const moved = "sortOrder" in next && next.sortOrder !== cur.sortOrder;
  if (!changed.length && !moved) return (await withIdentifiers(db, [cur]))[0];

  const [row] = await db
    .update(tasks)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();

  if (changed.length) {
    const rows = await Promise.all(
      changed.map(async (field) => ({
        taskId: id,
        actor,
        kind: "changed" as const,
        field,
        // Notes are free text — record that they changed, not the whole body twice.
        fromValue: field === "notes" ? null : await displayValue(db, field, cur[field as keyof Task]),
        toValue: field === "notes" ? null : await displayValue(db, field, next[field]),
      })),
    );
    await db.insert(taskActivity).values(rows);
  }
  if (changed.includes("status") || changed.includes("featureRef")) {
    await syncFeatureStatus(db, cur.featureRef);
    if (row.featureRef !== cur.featureRef) await syncFeatureStatus(db, row.featureRef);
  }
  return (await withIdentifiers(db, [row]))[0];
}

export async function addComment(db: Db, taskId: string, body: string, actor: Actor) {
  const text = body.trim();
  if (!text) throw new Error("Comment is empty");
  const [row] = await db.insert(taskActivity).values({ taskId, actor, kind: "comment", body: text }).returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return row;
}

export async function deleteWorkItem(db: Db, id: string): Promise<boolean> {
  const [row] = await db.delete(tasks).where(eq(tasks.id, id)).returning();
  if (!row) return false;
  // Children survive as top-level items; history goes with the item.
  await db.update(tasks).set({ parentId: null }).where(eq(tasks.parentId, id));
  await db.delete(taskActivity).where(eq(taskActivity.taskId, id));
  await db.delete(taskLinks).where(eq(taskLinks.taskId, id));
  await db.delete(taskRelations).where(or(eq(taskRelations.fromId, id), eq(taskRelations.toId, id)));
  await syncFeatureStatus(db, row.featureRef);
  return true;
}

// ── relations ──────────────────────────────────────────────────────────────


/** Store a relation the way a user states it from `id`'s side. */
export async function addRelation(db: Db, id: string, side: RelationSide, otherId: string, actor: Actor) {
  if (id === otherId) throw new Error("An item can't relate to itself");
  const [fromId, toId, kind]: [string, string, RelationKind] =
    side === "blocks" ? [id, otherId, "blocks"]
    : side === "blocked_by" ? [otherId, id, "blocks"]
    : side === "duplicates" ? [id, otherId, "duplicates"]
    : side === "duplicated_by" ? [otherId, id, "duplicates"]
    : [id, otherId, "relates"];
  if (kind === "blocks") {
    const [reverse] = await db
      .select({ id: taskRelations.id })
      .from(taskRelations)
      .where(and(eq(taskRelations.fromId, toId), eq(taskRelations.toId, fromId), eq(taskRelations.kind, "blocks")));
    if (reverse) throw new Error("Those two items would block each other");
  }
  const [row] = await db.insert(taskRelations).values({ fromId, toId, kind }).onConflictDoNothing().returning();
  if (row) {
    const keys = await projectKeyMap(db);
    const [other] = await db.select().from(tasks).where(eq(tasks.id, otherId));
    await db.insert(taskActivity).values({
      taskId: id,
      actor,
      kind: "changed",
      field: "relation",
      toValue: `${RELATION_SIDE_LABEL[side]} ${other ? (identifierOf(other, keys) ?? other.title) : "?"}`,
    });
  }
  return row ?? null;
}

export async function removeRelation(db: Db, relationId: string) {
  await db.delete(taskRelations).where(eq(taskRelations.id, relationId));
}

/** Every relation touching `id`, read from its side, with the other item. */
export async function listRelations(db: Db, id: string) {
  const rows = await db
    .select()
    .from(taskRelations)
    .where(or(eq(taskRelations.fromId, id), eq(taskRelations.toId, id)));
  if (!rows.length) return [];
  const otherIds = rows.map((r) => (r.fromId === id ? r.toId : r.fromId));
  const others = await withIdentifiers(db, await db.select().from(tasks).where(inArray(tasks.id, otherIds)));
  const byId = new Map(others.map((o) => [o.id, o]));
  return rows
    .map((r) => {
      const outgoing = r.fromId === id;
      const side: RelationSide =
        r.kind === "relates" ? "relates"
        : r.kind === "blocks" ? (outgoing ? "blocks" : "blocked_by")
        : outgoing ? "duplicates" : "duplicated_by";
      const other = byId.get(outgoing ? r.toId : r.fromId);
      return other ? { id: r.id, side, other } : null;
    })
    .filter((r) => r !== null);
}

/** Ids of open items that still have an open blocker. */
export async function blockedItemIds(db: Db): Promise<Set<string>> {
  const rows = await db.execute<{ id: string }>(sql`
    select r.to_id as id
    from task_relations r
    join tasks b on b.id = r.from_id
    join tasks t on t.id = r.to_id
    where r.kind = 'blocks'
      and b.status not in ('done','cancelled')
      and t.status not in ('done','cancelled')`);
  return new Set(rows.map((r) => r.id));
}

// ── links (commits, Workbench runs) ────────────────────────────────────────

export async function addLink(
  db: Db,
  taskId: string,
  link: { kind: LinkKind; ref: string; title?: string | null; url?: string | null; state?: string | null },
) {
  const [row] = await db
    .insert(taskLinks)
    .values({ taskId, ...link })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

// ── reads ──────────────────────────────────────────────────────────────────

export async function getWorkItem(db: Db, id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) return null;
  const [children, activity, relations, links] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.parentId, id)).orderBy(asc(tasks.sortOrder)),
    listActivity(db, id),
    listRelations(db, id),
    db.select().from(taskLinks).where(eq(taskLinks.taskId, id)).orderBy(desc(taskLinks.createdAt)),
  ]);
  const parent = row.parentId
    ? (await db.select().from(tasks).where(eq(tasks.id, row.parentId)))[0] ?? null
    : null;
  const [item, ...rest] = await withIdentifiers(db, [row, ...children, ...(parent ? [parent] : [])]);
  return {
    item,
    children: rest.slice(0, children.length),
    parent: parent ? rest[children.length] : null,
    activity,
    relations,
    links,
  };
}

export async function listWorkItems(
  db: Db,
  opts: { projectId?: string; statuses?: TaskStatus[]; limit?: number } = {},
): Promise<WorkItem[]> {
  const where = [
    opts.projectId ? eq(tasks.projectRef, `projects:${opts.projectId}`) : undefined,
    opts.statuses?.length ? inArray(tasks.status, opts.statuses) : undefined,
  ].filter((w) => w !== undefined);
  const rows = await db
    .select()
    .from(tasks)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(tasks.sortOrder), desc(tasks.createdAt))
    .limit(opts.limit ?? 2000);
  return withIdentifiers(db, rows);
}

// ── maintenance ────────────────────────────────────────────────────────────

/**
 * Idempotent: give every project a key and every item a number. Covers rows
 * written before numbering existed and any writer that bypassed this module.
 * Numbers follow creation order per scope, continuing from the counter.
 */
export async function backfillWork(db: Db): Promise<{ keys: number; numbers: number }> {
  let keys = 0;
  for (const p of await db.select({ id: projects.id }).from(projects).where(isNull(projects.key))) {
    if (await ensureProjectKey(db, p.id)) keys++;
  }
  const missing = await db
    .select({ id: tasks.id, projectRef: tasks.projectRef })
    .from(tasks)
    .where(isNull(tasks.number))
    .orderBy(asc(tasks.createdAt));
  for (const t of missing) {
    const n = await nextNumber(db, projectIdOf(t.projectRef) ?? LOOSE_SCOPE);
    await db.update(tasks).set({ number: n }).where(and(eq(tasks.id, t.id), isNull(tasks.number)));
  }
  return { keys, numbers: missing.length };
}
