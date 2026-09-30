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
  /** Units closed a day, over the last 14 days. */
  pace: number;
  /** When the open work runs out at that pace (null when nothing is closing). */
  forecastAt: number | null;
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

const PACE_DAYS = 14;
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

  const since = now - PACE_DAYS * DAY;
  const closedLately =
    items.filter((s) => isDone(s) && s.item.completedAt && +new Date(s.item.completedAt) >= since).length +
    entities.filter((e) => e.done && e.doneAt && +e.doneAt >= since).length;
  const pace = closedLately / PACE_DAYS;
  const forecastAt = total === 0 ? null : open === 0 ? now : pace > 0 ? now + (open / pace) * DAY : null;

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
