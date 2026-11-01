/**
 * A cycle's plan and how it went. The plan is what the cycle held at its
 * lock — the end of its first day, or of the day it was made when made late —
 * so items planned on the Sunday still count and anything joining after is
 * "added". Read from cycle_membership (one row per stay of an item in a
 * cycle), so roll-over and the done-date refile moving items on later never
 * change an earlier cycle's figures.
 *
 * Worker-safe: db passed in.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { cycleMembership, cycles, taskActivity, tasks, type Cycle, type TaskStatus } from "./schema";

const DAY = 86_400_000;

type Window = Pick<Cycle, "startsAt" | "endsAt" | "createdAt">;

/** When a cycle's plan is fixed: the end of its first day, or of the day it was made if made after it started. */
export const lockAt = (c: Window) => new Date(Math.max(c.startsAt.getTime(), c.createdAt.getTime()) + DAY);

const holds = (c: Window, t: Date) => t.getTime() >= c.startsAt.getTime() && t.getTime() < c.endsAt.getTime() + DAY;

export type Stay = { taskId: string; cycleId: string; joinedAt: Date; leftAt: Date | null; leftTo: string | null; leftReason?: string | null };
type Item = { status: TaskStatus; completedAt: Date | null };

export interface CyclePlan {
  /** Items the cycle held at its lock (before then: what it holds now), less those cancelled by its end. */
  planned: number;
  /** Planned items done inside the cycle's window. */
  plannedDone: number;
  /** Planned items cancelled by the cycle's end — de-scoped, so out of `planned`, and shown apart. */
  plannedCancelled: number;
  /** Items that joined after the lock. */
  added: number;
  addedDone: number;
  /** Planned items not done in the window that moved on to a later cycle. */
  carriedOver: number;
  carriedTo: { id: string; name: string; count: number }[];
  /** plannedDone ÷ planned; null with nothing planned. */
  ratio: number | null;
}

/** The plan figures of cycle `c` from its stays. `items` holds every staying item's current status. */
export function cyclePlan(
  c: Window & { id: string },
  stays: Stay[],
  items: Map<string, Item>,
  cycleById: Map<string, Pick<Cycle, "name" | "startsAt">>,
  now = Date.now(),
): CyclePlan {
  const at = Math.min(lockAt(c).getTime(), now);
  const p: CyclePlan = { planned: 0, plannedDone: 0, plannedCancelled: 0, added: 0, addedDone: 0, carriedOver: 0, carriedTo: [], ratio: null };
  const byTask = new Map<string, Stay[]>();
  for (const s of stays) if (s.cycleId === c.id) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
  const to = new Map<string, number>();
  for (const [taskId, mine] of byTask) {
    const item = items.get(taskId);
    if (!item) continue;
    const doneHere = item.status === "done" && !!item.completedAt && holds(c, item.completedAt);
    // Cancelled by the end of the window: de-scoped, not failed. Cancelled later still counts as a miss.
    const cancelledHere = item.status === "cancelled" && !!item.completedAt && item.completedAt.getTime() < c.endsAt.getTime() + DAY;
    // Rolled over before the lock: the roll-over froze the plan with the item in it.
    const planned = mine.some(
      (s) => s.joinedAt.getTime() <= at && (!s.leftAt || s.leftAt.getTime() > at || s.leftReason === "carried"),
    );
    if (planned && cancelledHere) p.plannedCancelled++;
    else if (planned) {
      p.planned++;
      if (doneHere) p.plannedDone++;
      else if (item.status !== "cancelled") {
        const last = mine.reduce((a, b) => (b.joinedAt > a.joinedAt ? b : a));
        const next = last.leftAt && last.leftTo ? cycleById.get(last.leftTo) : undefined;
        if (next && next.startsAt > c.startsAt) {
          p.carriedOver++;
          to.set(last.leftTo!, (to.get(last.leftTo!) ?? 0) + 1);
        }
      }
    } else if (mine.some((s) => s.joinedAt.getTime() > at)) {
      p.added++;
      if (doneHere) p.addedDone++;
    }
  }
  p.carriedTo = [...to].map(([id, count]) => ({ id, name: cycleById.get(id)!.name, count })).sort((a, b) => b.count - a.count);
  p.ratio = p.planned ? p.plannedDone / p.planned : null;
  return p;
}

/** Every stay in the given cycles, with the current status of each item in them. */
export async function loadStays(db: Db, cycleIds: string[]) {
  if (!cycleIds.length) return { stays: [] as Stay[], items: new Map<string, Item>() };
  const rows = await db
    .select({
      taskId: cycleMembership.taskId,
      cycleId: cycleMembership.cycleId,
      joinedAt: cycleMembership.joinedAt,
      leftAt: cycleMembership.leftAt,
      leftTo: cycleMembership.leftTo,
      leftReason: cycleMembership.leftReason,
      status: tasks.status,
      completedAt: tasks.completedAt,
    })
    .from(cycleMembership)
    .innerJoin(tasks, eq(tasks.id, cycleMembership.taskId))
    .where(inArray(cycleMembership.cycleId, cycleIds));
  const items = new Map<string, Item>();
  for (const r of rows) items.set(r.taskId, { status: r.status, completedAt: r.completedAt });
  return { stays: rows.map((r): Stay => ({ taskId: r.taskId, cycleId: r.cycleId, joinedAt: r.joinedAt, leftAt: r.leftAt, leftTo: r.leftTo, leftReason: r.leftReason })), items };
}

// ── Backfill: stays before the trigger, rebuilt from task_activity ─────────

/** A cycleId change from task_activity — cycle NAMES, as the history shows them. */
export type CycleEvent = { at: Date; from: string | null; to: string | null };

/** What a name in the history stands for: a cycle id, no cycle (null), or a cycle we can't identify. */
export const UNKNOWN = Symbol("unknown cycle");
type Resolved = string | null | typeof UNKNOWN;

export interface Rebuilt {
  stays: Stay[];
  /** Spans in which the item may have moved unseen (a roll-over wrote no history). */
  gaps: [Date, Date][];
  /** Cycles a break in the chain touches directly. */
  touched: string[];
}

/**
 * One item's stays from its cycleId history. Only roll-over (before this
 * change) and deleting a cycle moved items without a history row, so:
 * a chain whose next "from" isn't the last "to" had an unseen move in
 * between; an item that changed after creation may have been rolled into
 * its first known cycle; a name no cycle answers to hides where it was.
 * Each such span is a gap — any cycle whose lock falls in one can't say
 * whether the item was in its plan.
 */
export function rebuildStays(
  task: { id: string; cycleId: string | null; createdAt: Date; version: number },
  events: CycleEvent[],
  resolve: (name: string | null, at: Date) => Resolved,
  now: Date,
): Rebuilt {
  const out: Rebuilt = { stays: [], gaps: [], touched: [] };
  const real = (r: Resolved): r is string => typeof r === "string";
  const touch = (...rs: Resolved[]) => out.touched.push(...rs.filter(real));
  // A stay we know of; `cur` is UNKNOWN while the item sits in a cycle we can't name.
  let cur: Resolved;
  let since = task.createdAt;
  const close = (at: Date, to: Resolved) => {
    if (at <= since) return;
    if (real(cur)) out.stays.push({ taskId: task.id, cycleId: cur, joinedAt: since, leftAt: at, leftTo: real(to) ? to : null });
    else if (cur === UNKNOWN) out.gaps.push([since, at]);
  };
  if (!events.length) {
    if (task.cycleId) out.stays.push({ taskId: task.id, cycleId: task.cycleId, joinedAt: task.createdAt, leftAt: null, leftTo: null });
    // Never written since creation: it was made where it is. Otherwise a roll-over may have brought it.
    if (task.version > 1) out.gaps.push([task.createdAt, now]);
    return out;
  }
  cur = resolve(events[0].from, events[0].at);
  // It may have been rolled into its first known cycle; with no cycle, out of one.
  out.gaps.push([task.createdAt, events[0].at]);
  for (const e of events) {
    const from = resolve(e.from, e.at);
    if (from !== cur) {
      // An unseen move landed it where this row starts.
      out.gaps.push([since, e.at]);
      touch(cur, from);
      close(e.at, from);
      cur = from;
      since = e.at;
    }
    const to = resolve(e.to, e.at);
    close(e.at, to);
    cur = to;
    since = e.at;
  }
  const end: Resolved = task.cycleId;
  if (end !== cur) {
    out.gaps.push([since, now]);
    touch(cur, end);
    close(now, end);
    if (end) out.stays.push({ taskId: task.id, cycleId: end, joinedAt: now, leftAt: null, leftTo: null });
  } else if (real(cur)) out.stays.push({ taskId: task.id, cycleId: cur, joinedAt: since, leftAt: null, leftTo: null });
  else if (cur === UNKNOWN) out.gaps.push([since, now]);
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A history name → its cycle, among the item's family (its project's cycles
 * and the cross-project ones). A cycle renamed since ("Week of Oct 19" →
 * "Week of Oct 18") is found by the date in the old name: the family cycle
 * whose window holds it, the year taken nearest the row.
 */
export function nameResolver(family: Pick<Cycle, "id" | "name" | "startsAt" | "endsAt" | "createdAt">[]) {
  const byName = new Map<string, string[]>();
  for (const c of family) byName.set(c.name, [...(byName.get(c.name) ?? []), c.id]);
  return (name: string | null, at: Date): Resolved => {
    if (!name) return null;
    const ids = byName.get(name);
    if (ids?.length === 1) return ids[0];
    const m = name.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
    if (!m) return UNKNOWN;
    const year = at.getUTCFullYear();
    const hits = new Set<string>();
    for (const y of [year - 1, year, year + 1]) {
      const d = new Date(Date.UTC(y, MONTHS.indexOf(m[1]), Number(m[2]), 12));
      if (Math.abs(d.getTime() - at.getTime()) > 120 * DAY) continue;
      for (const c of family) if (holds(c, d)) hits.add(c.id);
    }
    return hits.size === 1 ? [...hits][0] : UNKNOWN;
  };
}

export interface BackfillReport {
  since: Date;
  cycles: { id: string; name: string; projectId: string | null; lock: Date; complete: boolean; reasons: number }[];
  stays: number;
}

/**
 * Rebuild the stays from before the trigger (`since`: its first live row, or
 * now) and mark each cycle locked before then whose plan the history can't
 * settle as historyComplete = false. Idempotent: the history rows are
 * replaced on every run; live rows are never touched.
 */
export async function backfillCycleHistory(db: Db, opts: { apply?: boolean; projectId?: string } = {}): Promise<BackfillReport> {
  const now = new Date();
  const [first] = await db
    .select({ at: sql<string | null>`min(${cycleMembership.joinedAt})` })
    .from(cycleMembership)
    .where(eq(cycleMembership.source, "live"));
  const since = first?.at ? new Date(first.at) : now;
  const allCycles = await db.select().from(cycles);
  // One project's run settles only its own cycles: cross-project ones hold other projects' items too.
  const scope = opts.projectId ? allCycles.filter((c) => c.projectId === opts.projectId) : allCycles;
  const items = await db
    .select({ id: tasks.id, cycleId: tasks.cycleId, createdAt: tasks.createdAt, version: tasks.version, projectRef: tasks.projectRef })
    .from(tasks)
    .where(opts.projectId ? eq(tasks.projectRef, `projects:${opts.projectId}`) : undefined);
  const events = await db
    .select({ taskId: taskActivity.taskId, at: taskActivity.createdAt, from: taskActivity.fromValue, to: taskActivity.toValue })
    .from(taskActivity)
    .where(and(eq(taskActivity.field, "cycleId"), eq(taskActivity.kind, "changed")))
    .orderBy(taskActivity.createdAt);
  const byTask = new Map<string, CycleEvent[]>();
  for (const e of events) byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), { at: e.at, from: e.from, to: e.to }]);

  const families = new Map<string, { fam: Cycle[]; resolve: ReturnType<typeof nameResolver> }>();
  const unsure = new Map<string, number>(); // cycle id → how many items leave its plan unsettled
  const mark = (id: string) => unsure.set(id, (unsure.get(id) ?? 0) + 1);
  const stays: Stay[] = [];
  for (const t of items) {
    const projectId = t.projectRef?.startsWith("projects:") ? t.projectRef.slice(9) : null;
    const key = projectId ?? "";
    if (!families.has(key)) {
      const fam = allCycles.filter((c) => c.projectId === projectId || c.projectId === null);
      families.set(key, { fam, resolve: nameResolver(fam) });
    }
    const { fam, resolve } = families.get(key)!;
    const r = rebuildStays(t, byTask.get(t.id) ?? [], resolve, now);
    // Stays that began after the trigger came in are its rows, not ours.
    stays.push(...r.stays.filter((s) => s.joinedAt < since));
    for (const c of fam) {
      const lock = lockAt(c);
      if (lock >= since) continue; // locked under the trigger: its plan is recorded
      if (r.touched.includes(c.id) || r.gaps.some(([a, b]) => lock > a && lock < b)) mark(c.id);
    }
  }
  const report: BackfillReport = {
    since,
    stays: stays.length,
    cycles: scope
      .map((c) => ({ id: c.id, name: c.name, projectId: c.projectId, lock: lockAt(c), complete: !unsure.has(c.id), reasons: unsure.get(c.id) ?? 0 }))
      .sort((a, b) => a.lock.getTime() - b.lock.getTime()),
  };
  if (!opts.apply) return report;
  await db.transaction(async (tx) => {
    const ids = items.map((t) => t.id);
    for (let i = 0; i < ids.length; i += 1000)
      await tx.delete(cycleMembership).where(and(eq(cycleMembership.source, "history"), inArray(cycleMembership.taskId, ids.slice(i, i + 1000))));
    for (let i = 0; i < stays.length; i += 500)
      await tx.insert(cycleMembership).values(stays.slice(i, i + 500).map((s) => ({ ...s, source: "history" as const })));
    for (const c of report.cycles)
      await tx.update(cycles).set({ historyComplete: c.complete }).where(eq(cycles.id, c.id));
  });
  return report;
}

/** One cycle's plan; null when its history can't rebuild it. */
export async function planOf(db: Db, c: Cycle): Promise<CyclePlan | null> {
  if (!c.historyComplete) return null;
  const [{ stays, items }, all] = await Promise.all([
    loadStays(db, [c.id]),
    db.select({ id: cycles.id, name: cycles.name, startsAt: cycles.startsAt }).from(cycles),
  ]);
  return cyclePlan(c, stays, items, new Map(all.map((x) => [x.id, x])));
}

/** The plan as tools return it: flat, and every figure null when the history can't rebuild it — never a guess. */
export const planFields = (plan: CyclePlan | null) => ({
  historyComplete: plan !== null,
  planned: plan?.planned ?? null,
  plannedDone: plan?.plannedDone ?? null,
  plannedCancelled: plan?.plannedCancelled ?? null,
  added: plan?.added ?? null,
  addedDone: plan?.addedDone ?? null,
  carriedOver: plan?.carriedOver ?? null,
  carriedTo: plan ? plan.carriedTo.map((t) => ({ cycle: t.name, items: t.count })) : null,
  ratio: plan?.ratio == null ? null : Math.round(plan.ratio * 1000) / 1000,
});
