/**
 * Cycles — time-boxed iterations. Status is derived from dates (no stored
 * state to drift); progress and burndown are derived from the member items.
 *
 * Worker-safe: db passed in.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { cycles, isClosed, taskActivity, tasks, type Cycle, type TaskStatus } from "./schema";

export type CycleStatus = "upcoming" | "current" | "completed";

export interface CycleSummary extends Cycle {
  status: CycleStatus;
  total: number;
  done: number;
  points: number;
  pointsDone: number;
  /** Remaining items at the end of each day of the cycle (up to today). */
  burndown: { day: string; remaining: number }[];
  /** Members that distort the cycle's figures — see cycleGhosts. */
  ghosts: number;
}

const DAY = 86_400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function cycleStatus(c: Pick<Cycle, "startsAt" | "endsAt">, now = Date.now()): CycleStatus {
  if (now < c.startsAt.getTime()) return "upcoming";
  // endsAt is the last day — the cycle runs through the end of it.
  if (now > c.endsAt.getTime() + DAY) return "completed";
  return "current";
}

/** Does the cycle's window hold `t`? It runs through the end of its last day. */
export const holds = (c: Pick<Cycle, "startsAt" | "endsAt">, t: Date) =>
  t.getTime() >= c.startsAt.getTime() && t.getTime() < c.endsAt.getTime() + DAY;

export interface CycleGhosts {
  /** Cancelled — still members, but in no figure. */
  cancelled: string[];
  /** Done, but on a date outside the window (no cycle holds that date). */
  doneOutside: string[];
  /** Open with no due date. */
  undated: string[];
  /** Open with a due date outside the window — already late, or due after it ends. */
  dueOutside: string[];
}

type GhostProbe = { id: string; status: TaskStatus; completedAt: Date | null; dueAt: Date | null };

/**
 * The members a cycle's counts quietly mislead about, each as item ids. The
 * buckets never overlap, so their sizes add up to the cycle's `ghosts`.
 */
export function cycleGhosts(c: Pick<Cycle, "startsAt" | "endsAt">, items: GhostProbe[]): CycleGhosts {
  const g: CycleGhosts = { cancelled: [], doneOutside: [], undated: [], dueOutside: [] };
  for (const t of items) {
    if (t.status === "cancelled") g.cancelled.push(t.id);
    else if (t.status === "done") {
      if (t.completedAt && !holds(c, t.completedAt)) g.doneOutside.push(t.id);
    } else if (!t.dueAt) g.undated.push(t.id);
    else if (!holds(c, t.dueAt)) g.dueOutside.push(t.id);
  }
  return g;
}

export const ghostCount = (g: CycleGhosts) => g.cancelled.length + g.doneOutside.length + g.undated.length + g.dueOutside.length;

/**
 * Where a done item belongs: the cycle whose window holds its done date, from
 * the same family as the cycle it sits in (that cycle's project, or the
 * cross-project cycles). Its current cycle when that already holds the date,
 * or when no cycle does — it is then reported as a `doneOutside` ghost.
 */
export async function homeCycle(db: Db, cycleId: string, doneAt: Date): Promise<string> {
  const [cur] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
  if (!cur || holds(cur, doneAt)) return cycleId;
  const [home] = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(
        cur.projectId ? eq(cycles.projectId, cur.projectId) : isNull(cycles.projectId),
        lte(cycles.startsAt, doneAt),
        sql`${cycles.endsAt} + interval '1 day' > ${doneAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(cycles.startsAt))
    .limit(1);
  return home?.id ?? cycleId;
}

/**
 * Move every done item whose done date lies outside its cycle to the cycle
 * that holds that date (homeCycle). The write path keeps this true for new
 * changes; this sweep repairs what predates it. Idempotent: an item with no
 * better home stays put and is skipped on every later pass.
 */
export async function reconcileDoneCycles(db: Db, opts: { projectId?: string; actor?: string } = {}): Promise<number> {
  const actor = opts.actor ?? "system:cycles";
  const strays = await db
    .select({ id: tasks.id, cycleId: tasks.cycleId, completedAt: tasks.completedAt, from: cycles.name })
    .from(tasks)
    .innerJoin(cycles, eq(cycles.id, tasks.cycleId))
    .where(
      and(
        eq(tasks.status, "done"),
        isNotNull(tasks.completedAt),
        sql`(${tasks.completedAt} < ${cycles.startsAt} or ${tasks.completedAt} >= ${cycles.endsAt} + interval '1 day')`,
        opts.projectId ? eq(cycles.projectId, opts.projectId) : undefined,
      ),
    );
  let moved = 0;
  for (const t of strays) {
    const home = await homeCycle(db, t.cycleId!, t.completedAt!);
    if (home === t.cycleId) continue;
    const [to] = await db.select({ name: cycles.name }).from(cycles).where(eq(cycles.id, home));
    const hit = await db
      .update(tasks)
      .set({ cycleId: home, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, t.id), eq(tasks.cycleId, t.cycleId!), eq(tasks.status, "done")))
      .returning({ id: tasks.id });
    if (!hit.length) continue; // changed under us since the select
    await db.insert(taskActivity).values({ taskId: t.id, actor, kind: "changed", field: "cycleId", fromValue: t.from, toValue: to?.name ?? null });
    moved++;
  }
  return moved;
}

/**
 * Remaining (open) items at each day's end. Uses today's membership, so an
 * item added mid-cycle counts from its creation day — scope creep shows up
 * as the line going UP, which is exactly what a burndown should reveal.
 */
export function burndown(
  c: Pick<Cycle, "startsAt" | "endsAt">,
  items: { createdAt: Date; completedAt: Date | null }[],
  now = Date.now(),
) {
  const out: { day: string; remaining: number }[] = [];
  const start = new Date(c.startsAt).setUTCHours(0, 0, 0, 0);
  const last = Math.min(new Date(c.endsAt).setUTCHours(0, 0, 0, 0), now);
  for (let d = start; d <= last; d += DAY) {
    const end = d + DAY;
    const remaining = items.filter(
      (t) => t.createdAt.getTime() < end && (!t.completedAt || t.completedAt.getTime() >= end),
    ).length;
    out.push({ day: dayKey(d), remaining });
  }
  return out;
}

export async function listCycles(db: Db, opts: { projectId?: string } = {}): Promise<CycleSummary[]> {
  // One round trip: every planned item's few columns come with the cycles
  // rather than after them (the DB is remote — each trip is ~60 ms).
  const [rows, members] = await Promise.all([
    db
      .select()
      .from(cycles)
      .where(opts.projectId ? eq(cycles.projectId, opts.projectId) : undefined)
      .orderBy(desc(cycles.startsAt)),
    db
      .select({
        id: tasks.id,
        cycleId: tasks.cycleId,
        status: tasks.status,
        estimate: tasks.estimate,
        createdAt: tasks.createdAt,
        completedAt: tasks.completedAt,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(isNotNull(tasks.cycleId)),
  ]);
  if (!rows.length) return [];
  const now = Date.now();
  return rows.map((c) => {
    const all = members.filter((m) => m.cycleId === c.id);
    const items = all.filter((m) => m.status !== "cancelled");
    const done = items.filter((m) => isClosed(m.status));
    return {
      ...c,
      status: cycleStatus(c, now),
      total: items.length,
      done: done.length,
      points: items.reduce((n, m) => n + (m.estimate ?? 0), 0),
      pointsDone: done.reduce((n, m) => n + (m.estimate ?? 0), 0),
      burndown: burndown(c, items, now),
      ghosts: ghostCount(cycleGhosts(c, all)),
    };
  });
}

function parseRange(startsAt: Date, endsAt: Date) {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error("Pick both dates");
  if (endsAt < startsAt) throw new Error("A cycle must end after it starts");
}

export async function createCycle(
  db: Db,
  input: { name: string; startsAt: Date; endsAt: Date; goal?: string | null; projectId?: string | null; externalRef?: string | null },
) {
  const name = input.name.trim();
  if (!name) throw new Error("Name the cycle");
  parseRange(input.startsAt, input.endsAt);
  const [row] = await db
    .insert(cycles)
    .values({
      name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      goal: input.goal?.trim() || null,
      projectId: input.projectId ?? null,
      externalRef: input.externalRef ?? null,
    })
    .returning();
  return row;
}

export async function updateCycle(db: Db, id: string, patch: { name?: string; startsAt?: Date; endsAt?: Date; goal?: string | null }) {
  const [cur] = await db.select().from(cycles).where(eq(cycles.id, id));
  if (!cur) throw new Error("Cycle not found");
  // A field left undefined keeps its value — spreading it would blank it.
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = { ...cur, ...given, name: (patch.name ?? cur.name).trim() };
  if (!next.name) throw new Error("Name the cycle");
  parseRange(next.startsAt, next.endsAt);
  await db
    .update(cycles)
    .set({ name: next.name, startsAt: next.startsAt, endsAt: next.endsAt, goal: next.goal?.trim() || null })
    .where(eq(cycles.id, id));
}

/** Deleting a cycle un-plans its items; it never deletes work. */
export async function deleteCycle(db: Db, id: string) {
  await db.update(tasks).set({ cycleId: null, version: sql`${tasks.version} + 1` }).where(eq(tasks.cycleId, id));
  await db.delete(cycles).where(eq(cycles.id, id));
}

/** Incomplete items of a finished cycle → the next one (or out of any cycle). */
export async function rollOverCycle(db: Db, fromId: string, toId: string | null) {
  const open = (await db.select().from(tasks).where(eq(tasks.cycleId, fromId))).filter((t) => !isClosed(t.status));
  if (open.length) {
    await db
      .update(tasks)
      .set({ cycleId: toId, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(inArray(tasks.id, open.map((t) => t.id)));
  }
  return open.length;
}

export async function cyclesForPicker(db: Db) {
  return db.select().from(cycles).orderBy(asc(cycles.startsAt));
}
