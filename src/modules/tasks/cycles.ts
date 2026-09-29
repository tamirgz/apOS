/**
 * Cycles — time-boxed iterations. Status is derived from dates (no stored
 * state to drift); progress and burndown are derived from the member items.
 *
 * Worker-safe: db passed in.
 */
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { cycles, isClosed, tasks, type Cycle } from "./schema";

export type CycleStatus = "upcoming" | "current" | "completed";

export interface CycleSummary extends Cycle {
  status: CycleStatus;
  total: number;
  done: number;
  points: number;
  pointsDone: number;
  /** Remaining items at the end of each day of the cycle (up to today). */
  burndown: { day: string; remaining: number }[];
}

const DAY = 86_400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function cycleStatus(c: Pick<Cycle, "startsAt" | "endsAt">, now = Date.now()): CycleStatus {
  if (now < c.startsAt.getTime()) return "upcoming";
  // endsAt is the last day — the cycle runs through the end of it.
  if (now > c.endsAt.getTime() + DAY) return "completed";
  return "current";
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
  const rows = await db
    .select()
    .from(cycles)
    .where(opts.projectId ? eq(cycles.projectId, opts.projectId) : undefined)
    .orderBy(desc(cycles.startsAt));
  if (!rows.length) return [];
  const members = await db
    .select({
      cycleId: tasks.cycleId,
      status: tasks.status,
      estimate: tasks.estimate,
      createdAt: tasks.createdAt,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(inArray(tasks.cycleId, rows.map((c) => c.id)));
  const now = Date.now();
  return rows.map((c) => {
    const items = members.filter((m) => m.cycleId === c.id && m.status !== "cancelled");
    const done = items.filter((m) => isClosed(m.status));
    return {
      ...c,
      status: cycleStatus(c, now),
      total: items.length,
      done: done.length,
      points: items.reduce((n, m) => n + (m.estimate ?? 0), 0),
      pointsDone: done.reduce((n, m) => n + (m.estimate ?? 0), 0),
      burndown: burndown(c, items, now),
    };
  });
}

function parseRange(startsAt: Date, endsAt: Date) {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error("Pick both dates");
  if (endsAt < startsAt) throw new Error("A cycle must end after it starts");
}

export async function createCycle(
  db: Db,
  input: { name: string; startsAt: Date; endsAt: Date; projectId?: string | null; externalRef?: string | null },
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
      projectId: input.projectId ?? null,
      externalRef: input.externalRef ?? null,
    })
    .returning();
  return row;
}

export async function updateCycle(db: Db, id: string, patch: { name?: string; startsAt?: Date; endsAt?: Date }) {
  const [cur] = await db.select().from(cycles).where(eq(cycles.id, id));
  if (!cur) throw new Error("Cycle not found");
  const next = { ...cur, ...patch, name: (patch.name ?? cur.name).trim() };
  if (!next.name) throw new Error("Name the cycle");
  parseRange(next.startsAt, next.endsAt);
  await db
    .update(cycles)
    .set({ name: next.name, startsAt: next.startsAt, endsAt: next.endsAt })
    .where(eq(cycles.id, id));
}

/** Deleting a cycle un-plans its items; it never deletes work. */
export async function deleteCycle(db: Db, id: string) {
  await db.update(tasks).set({ cycleId: null }).where(eq(tasks.cycleId, id));
  await db.delete(cycles).where(eq(cycles.id, id));
}

/** Incomplete items of a finished cycle → the next one (or out of any cycle). */
export async function rollOverCycle(db: Db, fromId: string, toId: string | null) {
  const open = (await db.select().from(tasks).where(eq(tasks.cycleId, fromId))).filter((t) => !isClosed(t.status));
  if (open.length) {
    await db
      .update(tasks)
      .set({ cycleId: toId, updatedAt: new Date() })
      .where(inArray(tasks.id, open.map((t) => t.id)));
  }
  return open.length;
}

export async function cyclesForPicker(db: Db) {
  return db.select().from(cycles).orderBy(asc(cycles.startsAt));
}
