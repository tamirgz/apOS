import type { CycleSummary } from "./cycles";
import type { WorkItem } from "./core";
import type { TaskStatus } from "./schema";

/**
 * Pure progress math for modules and cycles. No "use client" here on purpose:
 * the Work views (client) and the project Overview (server) both read it.
 */

const DAY = 86_400_000;
const isClosed = (s: TaskStatus) => s === "done" || s === "cancelled";

export interface ModuleStats {
  total: number;
  closed: number;
  open: number;
  /** Estimated points in scope, and how many of them are done. */
  points: number;
  pointsDone: number;
  by: Record<TaskStatus, number>;
}

const emptyBy = (): Record<TaskStatus, number> => ({ backlog: 0, todo: 0, doing: 0, review: 0, done: 0, cancelled: 0 });

/** Per-module item counts by state. Cancelled items count as closed but aren't scope. */
export function moduleStats(items: WorkItem[]): Map<string, ModuleStats> {
  const m = new Map<string, ModuleStats>();
  for (const t of items) {
    if (!t.featureRef?.startsWith("features:")) continue;
    const id = t.featureRef.slice(9);
    const s = m.get(id) ?? { total: 0, closed: 0, open: 0, points: 0, pointsDone: 0, by: emptyBy() };
    s.by[t.status]++;
    if (t.status === "cancelled") {
      m.set(id, s);
      continue;
    }
    s.total++;
    s.points += t.estimate ?? 0;
    if (t.status === "done") {
      s.closed++;
      s.pointsDone += t.estimate ?? 0;
    } else s.open++;
    m.set(id, s);
  }
  return m;
}

/** % done by points when the module's items are estimated, by item count otherwise. */
export function modulePct(s?: ModuleStats): number {
  if (!s?.total) return 0;
  return Math.round(s.points ? (s.pointsDone / s.points) * 100 : (s.closed / s.total) * 100);
}

export interface CycleMetrics {
  /** Weighted by points when any item in the cycle is estimated, else by count. */
  by: { done: number; review: number; doing: number; todo: number };
  total: number;
  unit: "pts" | "items";
  pct: number;
  daysLeft: number;
  /** Open items still in the cycle. */
  open: number;
  /** Items a day needed to finish on time vs. the last 7 days' closing rate. */
  need: number;
  pace: number;
  /** How much the open count rose above where it started. */
  scopeGrew: number;
  overdue: WorkItem[];
  blocked: WorkItem[];
}

/** Everything the cycle views read off one cycle — computed from the data, never a model call. */
export function cycleMetrics(c: CycleSummary, items: WorkItem[], blockedIds: string[], now: number): CycleMetrics {
  const inCycle = items.filter((t) => t.cycleId === c.id && t.status !== "cancelled");
  const usePts = inCycle.some((t) => t.estimate != null);
  const weight = (t: WorkItem) => (usePts ? (t.estimate ?? 0) : 1);
  const sum = (pred: (t: WorkItem) => boolean) => inCycle.filter(pred).reduce((n, t) => n + weight(t), 0);
  const total = inCycle.reduce((n, t) => n + weight(t), 0);
  const by = {
    done: sum((t) => t.status === "done"),
    review: sum((t) => t.status === "review"),
    doing: sum((t) => t.status === "doing"),
    todo: sum((t) => t.status === "todo" || t.status === "backlog"),
  };
  const daysLeft = Math.max(0, Math.ceil((+new Date(c.endsAt) + DAY - now) / DAY));
  const openItems = inCycle.filter((t) => !isClosed(t.status));
  const closedLastWeek = items.filter((t) => t.status === "done" && t.completedAt && now - +new Date(t.completedAt) < 7 * DAY).length;
  const blocked = new Set(blockedIds);
  return {
    by,
    total,
    unit: usePts ? "pts" : "items",
    pct: total ? Math.round((by.done / total) * 100) : 0,
    daysLeft,
    open: openItems.length,
    need: daysLeft > 0 ? openItems.length / daysLeft : openItems.length,
    pace: closedLastWeek / 7,
    scopeGrew: c.burndown.length ? Math.max(...c.burndown.map((p) => p.remaining)) - c.burndown[0].remaining : 0,
    overdue: openItems.filter((t) => t.dueAt && +new Date(t.dueAt) + DAY < now).sort((a, b) => +new Date(a.dueAt!) - +new Date(b.dueAt!)),
    blocked: openItems.filter((t) => blocked.has(t.id)),
  };
}

/** "3.4" / "12" — one decimal only while it matters. */
export const fmtRate = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ""));

