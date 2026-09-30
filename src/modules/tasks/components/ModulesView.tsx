"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Bot, Diamond, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act, done, errorText } from "@/core/ui/feedback";
import { shortDate } from "@/core/ui/time";
import { Markdown } from "@/core/ui/Markdown";
import { useNow } from "@/core/ui/useNow";
import { createFeature, deleteFeature, updateFeature } from "@/modules/projects/features-actions";
import type { FeatureStatus } from "@/modules/projects/schema";
import { delegateFeatureAction } from "../actions";
import type { WorkItem } from "../core";
import type { WorkFeature, WorkProject } from "../queries";
import { BOARD_STATUSES, STATUS_META } from "../states";
import { moduleStats, modulePct, type ModuleStats } from "../stats";
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

export { moduleStats, modulePct, type ModuleStats };

/** Done first, so the bar reads left-to-right like every other progress bar. */
const BAR_ORDER = [...BOARD_STATUSES].reverse();

/** One bar, one segment per state — how the module's work is spread, not just % done. */
export function StateBar({ s, className }: { s?: ModuleStats; className?: string }) {
  const total = s ? BOARD_STATUSES.reduce((n, st) => n + s.by[st], 0) : 0;
  return (
    <div
      className={cn("wk-bar", className)}
      role="img"
      aria-label={s ? BOARD_STATUSES.map((st) => `${s.by[st]} ${STATUS_META[st].label}`).join(", ") : "No items"}
    >
      {total > 0 &&
        BAR_ORDER.filter((st) => s!.by[st] > 0).map((st) => (
          <b
            key={st}
            style={{ width: `${(s!.by[st] / total) * 100}%`, background: STATUS_META[st].color, opacity: st === "done" ? 1 : 0.75 }}
            title={`${s!.by[st]} ${STATUS_META[st].label}`}
          />
        ))}
    </div>
  );
}

const isLate = (f: WorkFeature, now: number) =>
  !!f.targetAt && f.status !== "shipped" && f.status !== "cancelled" && +new Date(f.targetAt) + DAY < now;

function DateSpan({ f }: { f: WorkFeature }) {
  const now = useNow();
  if (!f.startAt && !f.targetAt) return <span className="font-mono text-[11px] text-ink-faint/70">no dates</span>;
  const late = isLate(f, now);
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-[11px] tabular-nums", late ? "text-flare" : "text-ink-faint")}>
      {f.startAt ? shortDate(f.startAt) : "—"}
      <ArrowRight className="size-2.5" />
      {f.targetAt ? shortDate(f.targetAt) : "—"}
      {late && ` · ${Math.max(1, Math.floor((now - +new Date(f.targetAt!)) / DAY))}d late`}
    </span>
  );
}

function StatusChip({ status }: { status: FeatureStatus }) {
  return (
    <span className="wk-chip !px-2 !py-px !text-[11px]" style={{ color: FEATURE_META[status].color }}>
      <i className="dot" />
      {FEATURE_META[status].label}
    </span>
  );
}

function ModuleGlyph({ status, size = 14 }: { status: FeatureStatus; size?: number }) {
  return <Diamond className="shrink-0" style={{ width: size, height: size, color: FEATURE_META[status].color }} fill="currentColor" fillOpacity={status === "shipped" ? 0.9 : 0.25} aria-hidden />;
}

type Filter = "build" | "shipped" | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "build", label: "In build" },
  { id: "shipped", label: "Shipped" },
  { id: "all", label: "All" },
];
const inFilter = (f: WorkFeature, filter: Filter) =>
  filter === "all" ? true : filter === "shipped" ? f.status === "shipped" : f.status === "planned" || f.status === "active" || f.status === "paused";
/** Live modules first, then shipped, then cancelled — within each, nearest target first. */
const BUCKET: Record<FeatureStatus, number> = { active: 0, planned: 0, paused: 0, shipped: 1, cancelled: 2 };

function ModuleCard({ f, s, onOpen }: { f: WorkFeature; s?: ModuleStats; onOpen: () => void }) {
  const now = useNow();
  const late = isLate(f, now);
  const pct = modulePct(s);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("wk-card group !gap-2.5 !p-3.5 text-left", late && "!border-flare/35")}
      title={late ? "Past its target date" : undefined}
    >
      <span className="flex items-start gap-2">
        <span className="mt-[3px]">
          <ModuleGlyph status={f.status} />
        </span>
        <span dir="auto" className="line-clamp-2 min-w-0 flex-1 font-display text-[15px] leading-snug text-ink transition group-hover:text-plasma">
          {f.name}
        </span>
        <StatusChip status={f.status} />
      </span>
      <DateSpan f={f} />
      <StateBar s={s} />
      <span className="flex items-center gap-2 text-xs tabular-nums text-ink-dim">
        <span className="text-ink">{s?.total ? `${pct}%` : "—"}</span>
        {s?.points ? (
          <span>
            {s.pointsDone}/{s.points} pts
          </span>
        ) : (
          <span>
            {s?.closed ?? 0}/{s?.total ?? 0} items
          </span>
        )}
        <span className={cn("ml-auto", (s?.open ?? 0) > 0 ? "text-ink-dim" : "text-ink-faint")}>
          {s?.open ? `${s.open} open` : s?.total ? "all closed" : "no items"}
        </span>
      </span>
    </button>
  );
}

/**
 * Modules (features): the chunks of a project that ship together, as cards —
 * span (late ones in flare), how the items are spread across states, and
 * progress by points (or items when nothing is estimated). Click one for its page.
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
  const now = useNow();
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
        BUCKET[a.status] - BUCKET[b.status] ||
        (a.targetAt ? +new Date(a.targetAt) : Infinity) - (b.targetAt ? +new Date(b.targetAt) : Infinity) ||
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
        a.sortOrder - b.sortOrder,
    );
  const groups = new Map<string, WorkFeature[]>();
  for (const f of shown) groups.set(projectId ? "" : f.projectId, [...(groups.get(projectId ? "" : f.projectId) ?? []), f]);
  const count = (fl: Filter) => features.filter((f) => inFilter(f, fl)).length;
  const late = features.filter((f) => isLate(f, now)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="wk-tabs" role="tablist" aria-label="Which modules">
          {FILTERS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={filter === x.id} onClick={() => setFilter(x.id)}>
              {x.label} <span className="font-mono text-[11px] tabular-nums text-ink-faint">{count(x.id)}</span>
            </button>
          ))}
        </div>
        {late > 0 && (
          <span className="wk-chip" style={{ color: "var(--color-flare)" }}>
            <i className="dot" />
            {late} past target
          </span>
        )}
        {projectId && (
          <button type="button" onClick={() => setAdding((v) => !v)} className="wk-btn primary ml-auto !py-1.5 text-xs">
            <Plus className="size-3.5" /> New module
          </button>
        )}
      </div>

      {adding && projectId && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            start(async () => {
              const r = await act(() => createFeature(projectId, name), { failed: "Couldn't create the module" });
              if (!r.ok) return;
              const row = r.value;
              setName("");
              setAdding(false);
              router.refresh();
              if (row) onOpen(row.id);
            });
          }}
          className="glass flex items-center gap-2 rounded-2xl p-2.5 pl-3.5"
        >
          <ModuleGlyph status="planned" size={15} />
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
          <button type="submit" disabled={pending || !name.trim()} className="wk-btn primary !py-1.5 text-xs">
            Add
          </button>
          <button type="button" onClick={() => setAdding(false)} className="wk-btn !py-1.5 text-xs">
            Cancel
          </button>
        </form>
      )}

      {shown.length === 0 && (
        <p className="glass rounded-2xl px-5 py-8 text-center text-sm text-ink-faint">
          {features.length === 0
            ? "No modules yet. A module groups the items that ship together — add one, then file items into it."
            : "Nothing here with this filter."}
        </p>
      )}

      {[...groups.entries()].map(([pid, fs]) => (
        <section key={pid || "project"} className="flex flex-col gap-2.5">
          {pid && (
            <Link href={`/m/projects/${pid}?tab=modules`} className="wk-sec-h w-fit transition hover:text-ink">
              {byProject.get(pid)?.key && byProject.get(pid)?.key !== byProject.get(pid)?.name && (
                <span className="text-ink-dim">{byProject.get(pid)?.key}</span>
              )}
              {byProject.get(pid)?.name ?? "Unknown project"}
              <span className="tabular-nums">{fs.length}</span>
            </Link>
          )}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {fs.map((f) => (
              <ModuleCard key={f.id} f={f} s={stats.get(f.id)} onOpen={() => onOpen(f.id)} />
            ))}
          </div>
        </section>
      ))}

      {shown.length > 0 && (
        <p className="flex flex-wrap items-center gap-3 px-1 text-[11.5px] text-ink-faint">
          {BOARD_STATUSES.map((st) => (
            <span key={st} className="inline-flex items-center gap-1.5">
              <i className="inline-block size-2 rounded-[2px]" style={{ background: STATUS_META[st].color }} />
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
function BurnUp({ items, from, to, height = 150 }: { items: WorkItem[]; from: number; to: number; height?: number }) {
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
  if (pts.length < 2)
    return (
      <div style={{ height }} className="grid place-items-center rounded-lg border border-dashed border-ion/15 text-xs text-ink-faint">
        The chart fills in as days pass.
      </div>
    );
  const W = 300;
  const H = height;
  const top = Math.max(1, ...pts.map((p) => p.total));
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => 4 + (1 - v / top) * (H - 8);
  const line = (k: "total" | "done") => pts.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      className="block w-full overflow-visible"
      role="img"
      aria-label={`${last.done} of ${last.total} done`}
    >
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          x2={W}
          y1={4 + f * (H - 8)}
          y2={4 + f * (H - 8)}
          stroke="color-mix(in oklab, var(--color-ion) 10%, transparent)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polyline
        points={line("total")}
        fill="none"
        stroke="color-mix(in oklab, var(--color-ink) 30%, transparent)"
        strokeWidth="1.3"
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={`0,${H} ${line("done")} ${W},${H}`} fill="color-mix(in oklab, var(--color-plasma) 14%, transparent)" />
      <polyline points={line("done")} fill="none" stroke="var(--color-plasma)" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={y(last.done)} r="3" fill="var(--color-plasma)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A module's page header: editable name, inline properties (state, start,
 * target), a markdown description, progress with a burn-up, and hand-off to
 * the Workbench. Its items render below.
 */
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
  const [editingDesc, setEditingDesc] = useState(false);
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
  const pct = modulePct(s);
  const late = isLate(f, now);
  const from = f.startAt ? +new Date(f.startAt) : Math.min(now, ...mine.map((t) => +new Date(t.createdAt)));
  const to = Math.min(now, f.targetAt ? Math.max(+new Date(f.targetAt), from + DAY) : now);
  const askQuery = `The "${f.name}" module${project ? ` of ${project.name}` : ""} — what's left, what's at risk, and what should happen next?`;

  const run = <T,>(fn: () => Promise<T>, after?: (r: T) => void) =>
    start(async () => {
      setError(null);
      try {
        after?.(await fn());
        router.refresh();
      } catch (e) {
        setError(errorText(e));
      }
    });
  const arm = (k: "delete" | "run") => {
    setArmed(k);
    setTimeout(() => setArmed((a) => (a === k ? null : a)), 4000);
  };
  const save = (patch: Parameters<typeof updateFeature>[2], saved?: string) =>
    run(() => updateFeature(f.id, f.projectId, patch), saved ? () => done(saved) : undefined);
  const day = (v: string) => (v ? new Date(`${v}T12:00:00`) : null);

  return (
    <section aria-label={f.name} className={cn("glass flex flex-col gap-4 rounded-2xl p-5", pending && "opacity-70")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={onBack} className="wk-btn !px-2 !py-1 text-xs" aria-label="Back to modules">
          <ArrowLeft className="size-3.5" /> Modules
        </button>
        <ModuleGlyph status={f.status} size={16} />
        <input
          dir="auto"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== f.name && save({ name }, "Module renamed")}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Module name"
          size={Math.max(8, Math.min(48, name.length + 1))}
          className="min-w-0 max-w-full rounded-lg bg-transparent px-1 font-display text-[22px] leading-tight text-ink outline-none transition hover:bg-ink/4 focus:bg-ink/6"
        />
        <StatusChip status={f.status} />
        {late && (
          <span className="wk-chip" style={{ color: "var(--color-flare)" }}>
            <i className="dot" />
            past target
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Link href={`/m/ask?q=${encodeURIComponent(askQuery)}`} className="wk-btn !py-1 text-xs">
            <Sparkles className="size-3.5 text-ion" /> Ask about this module
          </Link>
          {(s?.open ?? 0) > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                armed === "run"
                  ? run(
                      () => delegateFeatureAction(f.id),
                      (wb) => {
                        setArmed(null);
                        done("Handed to Workbench", { href: `/m/workbench/${wb.id}` });
                      },
                    )
                  : arm("run")
              }
              className="wk-btn violet !py-1 text-xs"
              title="One run takes all the module's open items; they move to In review when it finishes"
            >
              <Bot className="size-3.5" />
              {armed === "run" ? `Click again to hand ${s!.open} over` : "Delegate"}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => (armed === "delete" ? run(() => deleteFeature(f.id, f.projectId), onDeleted) : arm("delete"))}
            className={cn("wk-btn !py-1 text-xs", armed === "delete" ? "!border-flare/50 text-flare" : "!px-2 text-ink-faint hover:text-flare")}
            title="Delete module (its items stay in the project)"
            aria-label={`Delete ${f.name}`}
          >
            <Trash2 className="size-3.5" />
            {armed === "delete" && "Click again to delete"}
          </button>
        </span>
      </header>

      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.5fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <dl className="wk-props">
            <dt>State</dt>
            <dd>
              <select value={f.status} onChange={(e) => save({ status: e.target.value as FeatureStatus })} aria-label="Module state" className="wk-inline">
                {FEATURE_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {FEATURE_META[st].label}
                  </option>
                ))}
              </select>
            </dd>
            <dt>Start</dt>
            <dd>
              <input
                type="date"
                value={f.startAt ? dateInput(f.startAt) : ""}
                onChange={(e) => save({ startAt: day(e.target.value) })}
                aria-label="Start date"
                className="wk-inline"
              />
            </dd>
            <dt>Target</dt>
            <dd>
              <input
                type="date"
                value={f.targetAt ? dateInput(f.targetAt) : ""}
                onChange={(e) => save({ targetAt: day(e.target.value) })}
                aria-label="Target date"
                className={cn("wk-inline", late && "!text-flare")}
              />
            </dd>
            {project && (
              <>
                <dt>Project</dt>
                <dd>
                  <Link href={`/m/projects/${project.id}?tab=modules`} className="truncate text-ink-dim transition hover:text-ink">
                    {project.name}
                  </Link>
                </dd>
              </>
            )}
            <dt>Items</dt>
            <dd className="tabular-nums text-ink-dim">
              {s?.open ?? 0} open · {s?.closed ?? 0} done{s?.points ? ` · ${s.pointsDone}/${s.points} pts` : ""}
            </dd>
          </dl>

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="wk-sec-h">Description</h3>
              {!editingDesc && desc && (
                <button
                  type="button"
                  onClick={() => setEditingDesc(true)}
                  className="ml-auto inline-flex items-center gap-1 text-xs text-ink-faint transition hover:text-ink"
                >
                  <Pencil className="size-3" /> Edit
                </button>
              )}
            </div>
            {editingDesc ? (
              <textarea
                autoFocus
                dir="auto"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onBlur={() => {
                  setEditingDesc(false);
                  if (desc.trim() !== (f.description ?? "").trim()) save({ description: desc }, "Description saved");
                }}
                onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
                placeholder="What ships in this module, and when it counts as done… (markdown)"
                aria-label="Description"
                className="max-h-[50vh] min-h-28 w-full resize-y rounded-lg bg-ink/4 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink-dim outline-none placeholder:text-ink-faint focus:bg-ink/6"
              />
            ) : desc ? (
              <div className="max-h-[36vh] cursor-text overflow-y-auto [&_p]:!text-[13px]" onDoubleClick={() => setEditingDesc(true)} title="Double-click to edit">
                <Markdown>{desc}</Markdown>
              </div>
            ) : (
              <button type="button" onClick={() => setEditingDesc(true)} className="text-[13px] text-ink-faint transition hover:text-ink-dim">
                Add a description — what ships, and when it counts as done…
              </button>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <div className="mb-2 flex items-baseline gap-2.5">
              <span className="font-display text-[44px] leading-none tabular-nums text-ink">{s?.total ? `${pct}%` : "—"}</span>
              <span className="text-[13px] tabular-nums text-ink-dim">
                {s?.points ? `of ${s.points} pts done` : `of ${s?.total ?? 0} items done`}
              </span>
            </div>
            <StateBar s={s} className="!h-2.5" />
            <div className="mt-[7px] flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-ink-dim">
              {BAR_ORDER.filter((st) => (s?.by[st] ?? 0) > 0).map((st) => (
                <span key={st} className="inline-flex items-center gap-[5px]">
                  <i className="inline-block size-2 rounded-[2px]" style={{ background: STATUS_META[st].color }} />
                  {s!.by[st]} {STATUS_META[st].label.toLowerCase()}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-3 text-xs text-ink-faint">
              <span className="wk-sec-h">Burn-up</span>
              <span className="ml-auto inline-flex items-center gap-1.5">
                <i className="inline-block h-0.5 w-3.5 rounded bg-plasma" /> done
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="inline-block w-3.5 border-t border-dashed border-ink/35" /> scope
              </span>
            </div>
            <BurnUp items={mine} from={from} to={to} />
            <div className="mt-1.5 flex justify-between font-mono text-[11px] tabular-nums text-ink-faint">
              <span>{shortDate(new Date(from))}</span>
              <span>{to >= now - DAY ? "today" : shortDate(new Date(to))}</span>
            </div>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-flare">{error}</p>}
    </section>
  );
}
