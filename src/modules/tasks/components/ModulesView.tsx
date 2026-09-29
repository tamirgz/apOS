"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Bot, Layers, Plus, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import { createFeature, deleteFeature, updateFeature } from "@/modules/projects/features-actions";
import type { FeatureStatus } from "@/modules/projects/schema";
import { delegateFeatureAction } from "../actions";
import type { WorkItem } from "../core";
import type { WorkFeature, WorkProject } from "../queries";
import type { TaskStatus } from "../schema";
import { BOARD_STATUSES, STATUS_META } from "../states";
import { dateInput } from "./CyclePanel";

const DAY = 86_400_000;

export const FEATURE_META: Record<FeatureStatus, { label: string; color: string }> = {
  planned: { label: "Planned", color: "var(--color-ink-faint)" },
  active: { label: "Active", color: "var(--color-solar)" },
  paused: { label: "Paused", color: "var(--color-ink-faint)" },
  shipped: { label: "Shipped", color: "var(--color-plasma)" },
  cancelled: { label: "Cancelled", color: "var(--color-ink-faint)" },
};
const FEATURE_STATUSES = Object.keys(FEATURE_META) as FeatureStatus[];
const STATUS_RANK: Record<FeatureStatus, number> = { active: 0, planned: 1, paused: 2, shipped: 3, cancelled: 4 };

export interface ModuleStats {
  total: number;
  closed: number;
  open: number;
  by: Record<TaskStatus, number>;
}

const emptyBy = (): Record<TaskStatus, number> => ({ backlog: 0, todo: 0, doing: 0, review: 0, done: 0, cancelled: 0 });

/** Per-module item counts by state. Cancelled items count as closed but aren't scope. */
export function moduleStats(items: WorkItem[]): Map<string, ModuleStats> {
  const m = new Map<string, ModuleStats>();
  for (const t of items) {
    if (!t.featureRef?.startsWith("features:")) continue;
    const id = t.featureRef.slice(9);
    const s = m.get(id) ?? { total: 0, closed: 0, open: 0, by: emptyBy() };
    s.by[t.status]++;
    if (t.status === "cancelled") {
      m.set(id, s);
      continue;
    }
    s.total++;
    if (t.status === "done") s.closed++;
    else s.open++;
    m.set(id, s);
  }
  return m;
}

/** One bar, one segment per state — how the module's work is spread, not just % done. */
export function StateBar({ s, className }: { s?: ModuleStats; className?: string }) {
  const total = s ? BOARD_STATUSES.reduce((n, st) => n + s.by[st], 0) : 0;
  return (
    <div className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-white/6", className)} role="img" aria-label={s ? BOARD_STATUSES.map((st) => `${s.by[st]} ${STATUS_META[st].label}`).join(", ") : "No items"}>
      {total > 0 &&
        BOARD_STATUSES.filter((st) => s!.by[st] > 0).map((st) => (
          <span
            key={st}
            className="h-full"
            style={{ width: `${(s!.by[st] / total) * 100}%`, background: STATUS_META[st].color, opacity: st === "done" ? 0.85 : 0.7 }}
            title={`${s!.by[st]} ${STATUS_META[st].label}`}
          />
        ))}
    </div>
  );
}

function DateSpan({ f }: { f: WorkFeature }) {
  const now = useNow();
  if (!f.startAt && !f.targetAt) return <span className="font-mono text-[10px] text-ink-faint/60">no dates</span>;
  const late = f.targetAt && f.status !== "shipped" && f.status !== "cancelled" && +new Date(f.targetAt) + DAY < now;
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-[10px] tabular-nums", late ? "text-flare" : "text-ink-faint")}>
      {f.startAt ? shortDate(f.startAt) : "—"}
      <ArrowRight className="size-2.5" />
      {f.targetAt ? shortDate(f.targetAt) : "—"}
      {late && " · late"}
    </span>
  );
}

function StatusPill({ status }: { status: FeatureStatus }) {
  return (
    <span
      className="shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest"
      style={{ color: FEATURE_META[status].color, borderColor: "color-mix(in oklab, currentColor 35%, transparent)" }}
    >
      {FEATURE_META[status].label}
    </span>
  );
}

type Filter = "build" | "shipped" | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "build", label: "In build" },
  { id: "shipped", label: "Shipped" },
  { id: "all", label: "All" },
];
const inFilter = (f: WorkFeature, filter: Filter) =>
  filter === "all" ? true : filter === "shipped" ? f.status === "shipped" : f.status === "planned" || f.status === "active" || f.status === "paused";

/**
 * Modules (features): the chunks of a project that ship together. Each row
 * shows its span, how its items are spread across states, and progress; click
 * one for its page.
 */
export function ModulesView({
  features,
  items,
  projects,
  projectId,
  onOpen,
}: {
  features: WorkFeature[];
  items: WorkItem[];
  projects: WorkProject[];
  projectId?: string;
  onOpen: (id: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Filter>("build");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const stats = useMemo(() => moduleStats(items), [items]);
  const byProject = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const shown = features
    .filter((f) => inFilter(f, filter))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        (a.targetAt ? +new Date(a.targetAt) : Infinity) - (b.targetAt ? +new Date(b.targetAt) : Infinity) ||
        a.sortOrder - b.sortOrder,
    );
  const groups = new Map<string, WorkFeature[]>();
  for (const f of shown) groups.set(projectId ? "" : f.projectId, [...(groups.get(projectId ? "" : f.projectId) ?? []), f]);
  const count = (fl: Filter) => features.filter((f) => inFilter(f, fl)).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-white/8 p-0.5" role="tablist" aria-label="Which modules">
          {FILTERS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={filter === x.id}
              onClick={() => setFilter(x.id)}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition",
                filter === x.id ? "bg-white/8 text-ink" : "text-ink-faint hover:text-ink-dim",
              )}
            >
              {x.label} <span className="tabular-nums opacity-70">{count(x.id)}</span>
            </button>
          ))}
        </div>
        {projectId && (
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/5 hover:text-ink"
          >
            <Plus className="size-3" /> module
          </button>
        )}
      </div>

      {adding && projectId && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            start(async () => {
              const row = await createFeature(projectId, name);
              setName("");
              setAdding(false);
              router.refresh();
              if (row) onOpen(row.id);
            });
          }}
          className="glass flex items-center gap-2 rounded-xl p-1.5 pl-3"
        >
          <Layers className="size-4 text-solar" />
          <input
            autoFocus
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            placeholder="Module name — e.g. Offline sync"
            aria-label="Module name"
            disabled={pending}
            className="h-8 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <button type="submit" disabled={pending || !name.trim()} className="rounded-lg bg-solar/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-solar hover:bg-solar/25 disabled:opacity-40">
            add
          </button>
        </form>
      )}

      {shown.length === 0 && (
        <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">
          {features.length === 0
            ? "No modules yet. A module groups the items that ship together — add one, then file items into it."
            : "Nothing here with this filter."}
        </p>
      )}

      {[...groups.entries()].map(([pid, fs]) => (
        <section key={pid || "project"} className="flex flex-col gap-1.5">
          {pid && (
            <Link
              href={`/m/projects/${pid}?tab=modules`}
              className="flex w-fit items-center gap-2 px-1 pt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint transition hover:text-ink"
            >
              <span className="text-ink-dim">{byProject.get(pid)?.key}</span>
              {byProject.get(pid)?.name ?? "Unknown project"}
            </Link>
          )}
          <div className="glass overflow-hidden rounded-xl">
            <ul className="divide-y divide-white/5">
              {fs.map((f) => {
                const s = stats.get(f.id);
                const pct = s?.total ? Math.round((s.closed / s.total) * 100) : 0;
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(f.id)}
                      className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-left transition hover:bg-white/3 md:grid-cols-[auto_minmax(0,1fr)_8.5rem_10rem_3rem]"
                    >
                      <StatusPill status={f.status} />
                      <span dir="auto" className="min-w-0 truncate text-sm text-ink-dim transition group-hover:text-ink">{f.name}</span>
                      <span className="text-right md:text-left">
                        <DateSpan f={f} />
                      </span>
                      <span className="col-span-3 flex items-center gap-2 md:col-span-1">
                        <StateBar s={s} />
                      </span>
                      <span className="hidden text-right font-mono text-[10px] tabular-nums text-ink-faint md:block" title={`${s?.closed ?? 0} of ${s?.total ?? 0} done`}>
                        {s?.total ? `${pct}%` : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ))}

      {shown.length > 0 && (
        <p className="flex flex-wrap items-center gap-3 px-1 font-mono text-[10px] text-ink-faint">
          {BOARD_STATUSES.map((st) => (
            <span key={st} className="inline-flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: STATUS_META[st].color }} />
              {STATUS_META[st].label}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * Items done over time against total scope — scope stepping up mid-way is
 * visible as the top line rising, the way Plane's module chart reads.
 */
function BurnUp({ items, from, to, width = 220, height = 56 }: { items: WorkItem[]; from: number; to: number; width?: number; height?: number }) {
  const scope = items.filter((t) => t.status !== "cancelled");
  const days = Math.max(1, Math.round((to - from) / DAY));
  const step = Math.max(1, Math.ceil(days / 60));
  const pts: { total: number; done: number }[] = [];
  for (let d = 0; d <= days; d += step) {
    const end = from + (d + 1) * DAY;
    pts.push({
      total: scope.filter((t) => +new Date(t.createdAt) < end).length,
      done: scope.filter((t) => t.status === "done" && t.completedAt && +new Date(t.completedAt) < end).length,
    });
  }
  if (pts.length < 2) return null;
  const top = Math.max(1, ...pts.map((p) => p.total));
  const x = (i: number) => (i / (pts.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - (v / top) * (height - 8);
  const line = (k: "total" | "done") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block shrink-0" role="img" aria-label={`${last.done} of ${last.total} done`}>
      <path d={line("total")} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.25" strokeDasharray="3 3" />
      <path d={`${line("done")} L${x(pts.length - 1)},${height - 3} L${x(0)},${height - 3} Z`} fill="var(--color-plasma)" fillOpacity="0.1" />
      <path d={line("done")} fill="none" stroke="var(--color-plasma)" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={x(pts.length - 1)} cy={y(last.done)} r="2.5" fill="var(--color-plasma)" />
    </svg>
  );
}

/** A module's page header: editable name, state, span and description; progress and burn-up; hand it to the Workbench. */
export function ModuleHeader({
  f,
  items,
  project,
  onBack,
  onDeleted,
}: {
  f: WorkFeature;
  items: WorkItem[];
  project?: WorkProject;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const now = useNow();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<"delete" | "run" | null>(null);
  const [name, setName] = useState(f.name);
  const [desc, setDesc] = useState(f.description ?? "");
  const [seed, setSeed] = useState(f);
  if (seed !== f) {
    setSeed(f);
    setName(f.name);
    setDesc(f.description ?? "");
  }
  const mine = useMemo(() => items.filter((t) => t.featureRef === `features:${f.id}`), [items, f.id]);
  const s = moduleStats(mine).get(f.id);
  const pct = s?.total ? Math.round((s.closed / s.total) * 100) : 0;
  const from = f.startAt ? +new Date(f.startAt) : Math.min(now, ...mine.map((t) => +new Date(t.createdAt)));
  const to = Math.min(now, f.targetAt ? Math.max(+new Date(f.targetAt), from + DAY) : now);

  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    start(async () => {
      setError(null);
      try {
        await fn();
        after?.();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  const arm = (k: "delete" | "run") => {
    setArmed(k);
    setTimeout(() => setArmed((a) => (a === k ? null : a)), 4000);
  };
  const save = (patch: Parameters<typeof updateFeature>[2]) => run(() => updateFeature(f.id, f.projectId, patch));
  const day = (v: string) => (v ? new Date(`${v}T12:00:00`) : null);

  return (
    <section className={cn("glass flex flex-col gap-4 rounded-2xl p-4", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/5 hover:text-ink"
        >
          <ArrowLeft className="size-3" /> modules
        </button>
        {project && <span className="font-mono text-[10px] text-ink-faint">{project.key ?? project.name}</span>}
        <span className="ml-auto flex items-center gap-1">
          {(s?.open ?? 0) > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() => (armed === "run" ? run(() => delegateFeatureAction(f.id), () => setArmed(null)) : arm("run"))}
              className={cn(
                "flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition",
                armed === "run" ? "border border-violet/40 text-violet" : "text-ink-faint hover:text-violet",
              )}
              title="One Workbench run takes all the module's open items; they move to In review when it finishes"
            >
              <Bot className="size-3.5" />
              {armed === "run" ? `again to hand ${s!.open} over` : "workbench"}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => (armed === "delete" ? run(() => deleteFeature(f.id, f.projectId), onDeleted) : arm("delete"))}
            className={cn(
              "flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition",
              armed === "delete" ? "border border-flare/40 text-flare" : "text-ink-faint hover:text-flare",
            )}
            title="Delete module (its items stay in the project)"
          >
            <Trash2 className="size-3.5" />
            {armed === "delete" && "again to delete"}
          </button>
        </span>
      </div>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <input
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== f.name && save({ name })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Module name"
            className="rounded-lg bg-transparent px-1 font-display text-xl text-ink outline-none transition hover:bg-white/4 focus:bg-white/6"
          />
          <textarea
            dir="auto"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => desc.trim() !== (f.description ?? "").trim() && save({ description: desc })}
            placeholder="What ships in this module, and when it counts as done…"
            aria-label="Description"
            rows={Math.min(6, Math.max(2, desc.split("\n").length))}
            className="resize-y rounded-lg bg-white/3 px-2 py-1.5 text-sm leading-relaxed text-ink-dim outline-none placeholder:text-ink-faint focus:bg-white/6"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={f.status}
              onChange={(e) => save({ status: e.target.value as FeatureStatus })}
              aria-label="Module state"
              className="rounded-lg border border-white/8 bg-panel px-2 py-1 text-xs text-ink-dim outline-none"
            >
              {FEATURE_STATUSES.map((st) => (
                <option key={st} value={st}>{FEATURE_META[st].label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-faint">
              start
              <input
                type="date"
                value={f.startAt ? dateInput(f.startAt) : ""}
                onChange={(e) => save({ startAt: day(e.target.value) })}
                className="rounded-lg border border-white/8 bg-transparent px-2 py-1 text-xs text-ink-dim outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-faint">
              target
              <input
                type="date"
                value={f.targetAt ? dateInput(f.targetAt) : ""}
                onChange={(e) => save({ targetAt: day(e.target.value) })}
                className="rounded-lg border border-white/8 bg-transparent px-2 py-1 text-xs text-ink-dim outline-none"
              />
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-3xl tabular-nums text-ink">{pct}%</span>
            <span className="font-mono text-[10px] tabular-nums text-ink-faint">
              {s?.closed ?? 0}/{s?.total ?? 0} done
            </span>
          </div>
          <StateBar s={s} className="w-56" />
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-ink-faint">
            {BOARD_STATUSES.filter((st) => st !== "done" && (s?.by[st] ?? 0) > 0).map((st) => (
              <span key={st} className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ background: STATUS_META[st].color }} />
                {s!.by[st]} {STATUS_META[st].label.toLowerCase()}
              </span>
            ))}
          </div>
          <span className="text-ink-faint">
            <BurnUp items={mine} from={from} to={to} />
          </span>
          <span className="font-mono text-[9px] text-ink-faint">solid = done · dashed = total scope</span>
        </div>
      </div>
      {error && <p className="text-xs text-flare">{error}</p>}
    </section>
  );
}
