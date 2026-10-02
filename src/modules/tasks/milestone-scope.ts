import type { MilestoneContentKind, MilestoneCriterion, MilestoneStatus, TaskStatus } from "./schema";

/**
 * Pure scope and progress math for milestones. No "use client" and no db on
 * purpose: the Work views (client), the project Overview (server) and the
 * agent tools all resolve a milestone the same way.
 */

const DAY = 86_400_000;

export interface MilestoneInfo {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: MilestoneStatus;
  targetAt: Date | null;
  requires: string[];
  criteria: MilestoneCriterion[];
  sortOrder: number;
  doneAt: Date | null;
  createdAt: Date;
}

export interface CapabilityInfo {
  id: string;
  milestoneId: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

export interface ContentInfo {
  id: string;
  milestoneId: string;
  capabilityId: string | null;
  kind: MilestoneContentKind;
  targetId: string;
  entityKind: string | null;
  /** An entity's title (live from the search index, else the snapshot). */
  label: string | null;
  href: string | null;
  exclude: boolean;
  done: boolean;
  doneAt: Date | null;
  createdAt: Date;
}

export interface MilestoneBundle {
  milestones: MilestoneInfo[];
  capabilities: CapabilityInfo[];
  content: ContentInfo[];
}

export const emptyBundle = (): MilestoneBundle => ({ milestones: [], capabilities: [], content: [] });

/** The fields scope math reads off a work item — WorkItem and a tasks row both fit. */
export interface ScopeItem {
  id: string;
  status: TaskStatus;
  featureRef: string | null;
  estimate: number | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

export interface Scoped<T extends ScopeItem> {
  item: T;
  /** The capability of the content row that brought it in (null = ungrouped). */
  capabilityId: string | null;
  /** When it entered scope: the later of the item's creation and its content row's. */
  addedAt: number;
}

export interface Resolved<T extends ScopeItem> {
  /** Items in scope, cancelled ones left out (they're closed but never scope). */
  items: Scoped<T>[];
  /** Entity deliverables (notes, knowledge…) — each counts as one unit. */
  entities: ContentInfo[];
}

const KIND_ORDER: Record<MilestoneContentKind, number> = { item: 0, module: 1, milestone: 2, entity: 3 };

/**
 * Resolve every milestone's content to one de-duplicated set of items:
 * whole modules (live), single items, nested milestones (recursively, cycle
 * safe), minus the excluded modules and items. An item named on its own keeps
 * its own capability even when a module in scope brings it in too.
 */
export function milestoneResolver<T extends ScopeItem>(bundle: MilestoneBundle, items: T[]) {
  const byId = new Map(items.map((t) => [t.id, t]));
  const byFeature = new Map<string, T[]>();
  for (const t of items) {
    if (!t.featureRef?.startsWith("features:")) continue;
    const id = t.featureRef.slice(9);
    byFeature.set(id, [...(byFeature.get(id) ?? []), t]);
  }
  const rowsOf = new Map<string, ContentInfo[]>();
  for (const r of bundle.content) rowsOf.set(r.milestoneId, [...(rowsOf.get(r.milestoneId) ?? []), r]);
  const memo = new Map<string, { all: Scoped<T>[]; entities: ContentInfo[] }>();

  const walk = (id: string, stack: Set<string>): { all: Scoped<T>[]; entities: ContentInfo[] } => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (stack.has(id)) return { all: [], entities: [] };
    stack.add(id);
    const rows = [...(rowsOf.get(id) ?? [])].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const exItems = new Set(rows.filter((r) => r.exclude && r.kind === "item").map((r) => r.targetId));
    const exModules = new Set(rows.filter((r) => r.exclude && r.kind === "module").map((r) => r.targetId));
    const out = new Map<string, Scoped<T>>();
    const entities = new Map<string, ContentInfo>();
    const add = (t: T, row: ContentInfo, since = 0) => {
      if (out.has(t.id) || exItems.has(t.id)) return;
      if (t.featureRef?.startsWith("features:") && exModules.has(t.featureRef.slice(9))) return;
      out.set(t.id, { item: t, capabilityId: row.capabilityId, addedAt: Math.max(+new Date(t.createdAt), +row.createdAt, since) });
    };
    for (const r of rows) {
      if (r.exclude) continue;
      if (r.kind === "item") {
        const t = byId.get(r.targetId);
        if (t) add(t, r);
      } else if (r.kind === "module") {
        for (const t of byFeature.get(r.targetId) ?? []) add(t, r);
      } else if (r.kind === "milestone") {
        const sub = walk(r.targetId, stack);
        for (const s of sub.all) add(s.item, r, s.addedAt);
        for (const e of sub.entities) if (!entities.has(e.id)) entities.set(e.id, { ...e, capabilityId: r.capabilityId });
      } else if (!entities.has(r.id)) entities.set(r.id, r);
    }
    stack.delete(id);
    const res = { all: [...out.values()], entities: [...entities.values()] };
    // A walk cut short by a cycle is partial — only a clean top-level walk is memoised.
    if (stack.size === 0) memo.set(id, res);
    return res;
  };

  return (id: string): Resolved<T> => {
    const r = walk(id, new Set());
    return { items: r.all.filter((s) => s.item.status !== "cancelled"), entities: r.entities };
  };
}

/** How a milestone stands against its target — read off the data, never a model call. */
export type Outlook = "done" | "cancelled" | "empty" | "complete" | "on-track" | "at-risk" | "late" | "stalled" | "unscheduled";

export const OUTLOOK_META: Record<Outlook, { label: string; color: string }> = {
  done: { label: "Reached", color: "var(--color-plasma)" },
  cancelled: { label: "Cancelled", color: "var(--color-ink-faint)" },
  empty: { label: "No content yet", color: "var(--color-ink-faint)" },
  complete: { label: "Ready to close", color: "var(--color-plasma)" },
  "on-track": { label: "On track", color: "var(--color-plasma)" },
  "at-risk": { label: "At risk", color: "var(--color-solar)" },
  late: { label: "Late", color: "var(--color-flare)" },
  stalled: { label: "Stalled", color: "var(--color-solar)" },
  unscheduled: { label: "No target", color: "var(--color-ink-faint)" },
};

export interface GroupStats {
  total: number;
  done: number;
  pct: number;
}

export interface MilestoneStats {
  /** Units in scope: items (not cancelled) plus entity deliverables. */
  total: number;
  done: number;
  open: number;
  pct: number;
  /** Item counts by state (entities are not in here). */
  by: Record<TaskStatus, number>;
  entities: GroupStats;
  /** Units closed a day over the pace window (estimate-weighted, imports left out). */
  pace: number;
  /**
   * The median finish (P50) of a throughput simulation: the window's daily
   * closes replayed at random until the open work runs out. Null when nothing
   * closed in the window.
   */
  forecastAt: number | null;
  /** The pessimistic finish (P85) — 85% of the simulated runs are done by then. */
  forecastLate: number | null;
  /** The median lands past the simulation's horizon (~3 years). */
  forecastBeyond: boolean;
  /** What the forecast rests on: closes counted, over how many days; `low` = too few to trust. */
  basis: { closes: number; days: number; low: boolean };
  outlook: Outlook;
  /** Per capability, in the milestone's order; `id: null` = ungrouped content. */
  capabilities: (GroupStats & { id: string | null; name: string; description: string | null })[];
  /** Per module the items came from (id "" = items in no module). */
  modules: (GroupStats & { id: string })[];
  /** Scope against done, one point a day (at most ~60). */
  burnup: { t: number; scope: number; done: number }[];
  criteria: GroupStats;
  /** Required milestones not reached yet — the readiness gate. */
  waitingOn: { id: string; name: string; pct: number }[];
}

/** Pace window: the last six weeks, or since the oldest content existed when younger (a week at least). */
const WINDOW_DAYS = 42;
const MIN_WINDOW_DAYS = 7;
/** Fewer closes than this in the window and the forecast is flagged low-confidence. */
const MIN_CLOSES = 5;
const TRIALS = 500;
const HORIZON_DAYS = 3 * 365;
/** A close stamped this soon after creation is an import of finished work, not throughput. */
const IMPORT_GAP = 60_000;
/** Share of an open item already behind it, by state. */
const CREDIT: Partial<Record<TaskStatus, number>> = { doing: 0.5, review: 0.8 };
const weightOf = (t: ScopeItem) => (t.estimate && t.estimate > 0 ? t.estimate : 1);

/** Deterministic PRNG (mulberry32): the same milestone on the same day forecasts the same everywhere. */
function rngFor(key: string, dayIndex: number) {
  let h = 2166136261 ^ dayIndex;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Throughput forecast (the Monte Carlo method): the window's daily closes are
 * sampled at random, day after day, until the open work is used up — repeated
 * TRIALS times. Returns the days the 50th and 85th percentile runs needed
 * (HORIZON_DAYS when a run never finished).
 */
function simulate(daily: number[], remaining: number, rand: () => number): { p50: number; p85: number } {
  const runs: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    let left = remaining;
    let d = 0;
    while (left > 1e-9 && d < HORIZON_DAYS) {
      left -= daily[Math.floor(rand() * daily.length)];
      d++;
    }
    runs.push(d);
  }
  runs.sort((a, b) => a - b);
  return { p50: runs[Math.floor(TRIALS * 0.5)], p85: runs[Math.floor(TRIALS * 0.85)] };
}
const emptyBy = (): Record<TaskStatus, number> => ({ backlog: 0, todo: 0, doing: 0, review: 0, done: 0, cancelled: 0 });
const pctOf = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);
const group = (done: number, total: number): GroupStats => ({ total, done, pct: pctOf(done, total) });

export function milestoneStats<T extends ScopeItem>(
  m: MilestoneInfo,
  bundle: MilestoneBundle,
  resolve: (id: string) => Resolved<T>,
  now: number,
): MilestoneStats {
  const { items, entities } = resolve(m.id);
  const isDone = (s: Scoped<T>) => s.item.status === "done";
  const by = emptyBy();
  for (const s of items) by[s.item.status]++;
  const entDone = entities.filter((e) => e.done).length;
  const total = items.length + entities.length;
  const done = by.done + entDone;
  const open = total - done;

  // Pace window: six weeks back, but not before the oldest content existed —
  // work created last week has no six weeks of history to average over.
  const oldest = Math.min(now, ...items.map((s) => +new Date(s.item.createdAt)), ...entities.map((e) => +e.createdAt));
  const windowDays = Math.max(MIN_WINDOW_DAYS, Math.min(WINDOW_DAYS, Math.ceil((now - oldest) / DAY)));
  const since = now - windowDays * DAY;
  const daily = new Array<number>(windowDays).fill(0);
  let closes = 0;
  const count = (created: number, closedAt: number | null, w: number) => {
    if (closedAt == null || closedAt < since || closedAt - created < IMPORT_GAP) return;
    daily[Math.min(windowDays - 1, Math.floor((closedAt - since) / DAY))] += w;
    closes++;
  };
  for (const s of items) if (isDone(s)) count(+new Date(s.item.createdAt), s.item.completedAt ? +new Date(s.item.completedAt) : null, weightOf(s.item));
  for (const e of entities) if (e.done) count(+e.createdAt, e.doneAt ? +e.doneAt : null, 1);
  const throughput = daily.reduce((a, b) => a + b, 0);
  const pace = throughput / windowDays;
  // Open work, weighted by estimate, less what's already behind items in flight.
  const remaining =
    items.reduce((a, s) => (isDone(s) ? a : a + weightOf(s.item) * (1 - (CREDIT[s.item.status] ?? 0))), 0) +
    entities.filter((e) => !e.done).length;
  let forecastAt: number | null = null;
  let forecastLate: number | null = null;
  let forecastBeyond = false;
  if (total > 0 && open === 0) forecastAt = forecastLate = now;
  else if (total > 0 && throughput > 0) {
    const { p50, p85 } = simulate(daily, remaining, rngFor(m.id, Math.floor(now / DAY)));
    forecastBeyond = p50 >= HORIZON_DAYS;
    forecastAt = now + p50 * DAY;
    forecastLate = p85 >= HORIZON_DAYS ? null : now + p85 * DAY;
  }

  const target = m.targetAt ? +m.targetAt : null;
  const outlook: Outlook =
    m.status === "done"
      ? "done"
      : m.status === "cancelled"
        ? "cancelled"
        : total === 0
          ? "empty"
          : open === 0
            ? "complete"
          : target == null
            ? "unscheduled"
            : target + DAY < now
              ? "late"
              : forecastAt == null
                ? "stalled"
                : forecastAt > target + DAY
                  ? "at-risk"
                  : "on-track";

  const caps = bundle.capabilities.filter((c) => c.milestoneId === m.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const capCount = new Map<string | null, { total: number; done: number }>();
  const bump = (k: string | null, d: boolean) => {
    const c = capCount.get(k) ?? { total: 0, done: 0 };
    c.total++;
    if (d) c.done++;
    capCount.set(k, c);
  };
  for (const s of items) bump(s.capabilityId, isDone(s));
  for (const e of entities) bump(e.capabilityId, e.done);
  const capabilities: MilestoneStats["capabilities"] = caps.map((c) => {
    const n = capCount.get(c.id) ?? { total: 0, done: 0 };
    return { id: c.id, name: c.name, description: c.description, ...group(n.done, n.total) };
  });
  const loose = capCount.get(null);
  if (loose) capabilities.push({ id: null, name: caps.length ? "Other content" : "Content", description: null, ...group(loose.done, loose.total) });

  const modCount = new Map<string, { total: number; done: number }>();
  for (const s of items) {
    const k = s.item.featureRef?.startsWith("features:") ? s.item.featureRef.slice(9) : "";
    const c = modCount.get(k) ?? { total: 0, done: 0 };
    c.total++;
    if (isDone(s)) c.done++;
    modCount.set(k, c);
  }
  const modules = [...modCount.entries()].map(([id, c]) => ({ id, ...group(c.done, c.total) })).sort((a, b) => b.total - a.total);

  // Burn-up over the content's own history: an item counts from its creation and
  // is delivered from its completion, so a milestone defined today over months-old
  // work still shows how that work got here. Entities have no history of their own
  // beyond joining and being marked done.
  const points: { add: number; done: number | null }[] = [
    ...items.map((s) => {
      const add = +new Date(s.item.createdAt);
      return { add, done: isDone(s) ? Math.max(add, s.item.completedAt ? +new Date(s.item.completedAt) : add) : null };
    }),
    ...entities.map((e) => ({ add: +e.createdAt, done: e.done ? Math.max(+(e.doneAt ?? e.createdAt), +e.createdAt) : null })),
  ];
  const from = points.length ? Math.min(...points.map((p) => p.add)) : +m.createdAt;
  const days = Math.max(1, Math.ceil((now - from) / DAY));
  const step = Math.max(1, Math.ceil(days / 60));
  const burnup: MilestoneStats["burnup"] = [];
  for (let d = 0; d <= days; d += step) {
    const t = Math.min(now, from + (d + 1) * DAY);
    burnup.push({ t, scope: points.filter((p) => p.add <= t).length, done: points.filter((p) => p.done != null && p.done <= t).length });
  }

  const byId = new Map(bundle.milestones.map((x) => [x.id, x]));
  const waitingOn = m.requires
    .map((id) => byId.get(id))
    .filter((r): r is MilestoneInfo => !!r && r.status !== "done" && r.status !== "cancelled")
    .map((r) => {
      const rr = resolve(r.id);
      const t = rr.items.length + rr.entities.length;
      const d = rr.items.filter((s) => s.item.status === "done").length + rr.entities.filter((e) => e.done).length;
      return { id: r.id, name: r.name, pct: pctOf(d, t) };
    });

  return {
    total,
    done,
    open,
    pct: pctOf(done, total),
    by,
    entities: group(entDone, entities.length),
    pace,
    forecastAt,
    forecastLate,
    forecastBeyond,
    basis: { closes, days: windowDays, low: closes < MIN_CLOSES },
    outlook,
    capabilities,
    modules,
    burnup,
    criteria: group(m.criteria.filter((c) => c.done).length, m.criteria.length),
    waitingOn,
  };
}

/** Roadmap order: the project's own order, then nearest target. */
export function orderMilestones(ms: MilestoneInfo[]): MilestoneInfo[] {
  return [...ms].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      (a.targetAt ? +a.targetAt : Infinity) - (b.targetAt ? +b.targetAt : Infinity) ||
      +a.createdAt - +b.createdAt,
  );
}
