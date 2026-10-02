"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Circle, Diamond, Flag, Lock, MinusCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { Markdown } from "@/core/ui/Markdown";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "../core";
import {
  milestoneResolver,
  milestoneStats,
  OUTLOOK_META,
  orderMilestones,
  type ContentInfo,
  type MilestoneBundle,
  type MilestoneInfo,
  type MilestoneStats,
  type Outlook,
} from "../milestone-scope";
import {
  addMilestoneContent,
  deleteCapability,
  deleteMilestoneAction,
  removeMilestoneContent,
  saveCapability,
  updateMilestoneAction,
} from "../milestone-actions";
import type { WorkFeature, WorkProject } from "../queries";
import { STATUS_META } from "../states";
import { MILESTONE_STATUSES, type MilestoneStatus, type TaskStatus } from "../schema";
import { dateInput } from "./CyclePanel";
import { ContentPicker, CriteriaEditor, NewMilestone, RequiresEditor, useMilestoneWrite } from "./MilestoneEdit";

const DAY = 86_400_000;

/** The resolver and every milestone's stats, computed once per data change. */
export function useMilestoneStats(bundle: MilestoneBundle, items: WorkItem[]) {
  const now = useNow();
  return useMemo(() => {
    const resolve = milestoneResolver(bundle, items);
    const stats = new Map<string, MilestoneStats>();
    for (const m of bundle.milestones) stats.set(m.id, milestoneStats(m, bundle, resolve, now));
    return { resolve, stats };
  }, [bundle, items, now]);
}

export function MilestoneGlyph({ outlook, size = 14 }: { outlook: Outlook; size?: number }) {
  const reached = outlook === "done";
  return (
    <Flag
      className="shrink-0"
      style={{ width: size, height: size, color: OUTLOOK_META[outlook].color }}
      fill="currentColor"
      fillOpacity={reached ? 0.85 : 0.2}
      aria-hidden
    />
  );
}

function OutlookChip({ outlook }: { outlook: Outlook }) {
  return (
    <span className="wk-chip !px-2 !py-px !text-[11px]" style={{ color: OUTLOOK_META[outlook].color }}>
      <i className="dot" />
      {OUTLOOK_META[outlook].label}
    </span>
  );
}

/** Done → review → doing → still to start, with entity deliverables folded into done / to-start. */
const SEGMENTS: { key: "done" | "review" | "doing" | "todo"; label: string; color: string; opacity: number }[] = [
  { key: "done", label: "done", color: STATUS_META.done.color, opacity: 1 },
  { key: "review", label: "in review", color: STATUS_META.review.color, opacity: 0.8 },
  { key: "doing", label: "in progress", color: STATUS_META.doing.color, opacity: 0.8 },
  { key: "todo", label: "not started", color: STATUS_META.todo.color, opacity: 0.35 },
];

function segmentsOf(s: MilestoneStats) {
  const openEntities = s.entities.total - s.entities.done;
  return {
    done: s.by.done + s.entities.done,
    review: s.by.review,
    doing: s.by.doing,
    todo: s.by.todo + s.by.backlog + openEntities,
  };
}

export function MilestoneBar({ s, big }: { s: MilestoneStats; big?: boolean }) {
  const seg = segmentsOf(s);
  return (
    <div
      className={cn("wk-bar", big && "!h-2.5")}
      role="img"
      aria-label={`${s.done} of ${s.total} done${seg.doing ? `, ${seg.doing} in progress` : ""}${seg.review ? `, ${seg.review} in review` : ""}`}
    >
      {s.total > 0 &&
        SEGMENTS.filter((x) => seg[x.key] > 0).map((x) => (
          <b key={x.key} style={{ width: `${(seg[x.key] / s.total) * 100}%`, background: x.color, opacity: x.opacity }} title={`${seg[x.key]} ${x.label}`} />
        ))}
    </div>
  );
}

function BarLegend({ s }: { s: MilestoneStats }) {
  const seg = segmentsOf(s);
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-ink-dim">
      {SEGMENTS.map((x) => (
        <span key={x.key} className="inline-flex items-center gap-[5px]">
          <i className="inline-block size-2 rounded-[2px]" style={{ background: x.color, opacity: x.opacity }} />
          {seg[x.key]} {x.label}
        </span>
      ))}
    </div>
  );
}

/** "12 Dec" target and where the pace lands — the forecast in flare when it misses. */
function TargetLine({ m, s }: { m: MilestoneInfo; s: MilestoneStats }) {
  const misses = !!m.targetAt && s.forecastAt != null && s.forecastAt > +m.targetAt + DAY;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] tabular-nums text-ink-faint">
      {m.targetAt ? <span>target {shortDate(m.targetAt)}</span> : <span>no target</span>}
      {s.open > 0 && m.status !== "done" && (
        <>
          <span aria-hidden>·</span>
          <span className={cn(misses && "text-flare")}>{s.forecastAt == null ? "no pace yet" : s.forecastBeyond ? "forecast 3 yrs+" : `forecast ${s.basis.low ? "~" : ""}${shortDate(new Date(s.forecastAt))}`}</span>
        </>
      )}
    </span>
  );
}

// ── the roadmap ─────────────────────────────────────────────────────────────

type Filter = "live" | "reached" | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "live", label: "In play" },
  { id: "reached", label: "Reached" },
  { id: "all", label: "All" },
];
const inFilter = (m: MilestoneInfo, f: Filter) =>
  f === "all" ? true : f === "reached" ? m.status === "done" : m.status === "planned" || m.status === "active";

function MilestoneCard({
  m,
  s,
  names,
  onOpen,
}: {
  m: MilestoneInfo;
  s: MilestoneStats;
  names: Map<string, string>;
  onOpen: () => void;
}) {
  const caps = s.capabilities.filter((c) => c.total > 0 || c.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("wk-card group !cursor-pointer !gap-3 !p-4", s.outlook === "late" && "!border-flare/35")}
    >
      <span className="flex flex-wrap items-center gap-2">
        <MilestoneGlyph outlook={s.outlook} size={15} />
        <span dir="auto" className="min-w-0 font-display text-[16px] leading-snug text-ink transition group-hover:text-plasma">
          {m.name}
        </span>
        <OutlookChip outlook={s.outlook} />
        {s.waitingOn.length > 0 && (
          <span className="wk-chip !px-2 !py-px !text-[11px]" title="Required milestones not reached yet">
            <Lock className="size-3" /> after {s.waitingOn.map((w) => names.get(w.id) ?? w.name).join(", ")}
          </span>
        )}
        <span className="ml-auto font-display text-[20px] tabular-nums leading-none text-ink">{s.total ? `${s.pct}%` : "—"}</span>
      </span>
      <MilestoneBar s={s} big />
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-ink-dim">
        <span>
          <span className="text-ink">{s.done}</span>/{s.total} delivered
        </span>
        {s.criteria.total > 0 && (
          <span>
            {s.criteria.done}/{s.criteria.total} criteria
          </span>
        )}
        <span className="ml-auto">
          <TargetLine m={m} s={s} />
        </span>
      </span>
      {caps.length > 0 && (
        <span className="grid gap-x-5 gap-y-1.5 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
          {caps.slice(0, 12).map((c) => (
            <span key={c.id ?? "loose"} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span dir="auto" className="min-w-0 flex-1 truncate text-ink-dim">
                {c.name}
              </span>
              <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-ink/[0.08]">
                <span className="block h-full rounded-full" style={{ width: `${c.pct}%`, background: STATUS_META.done.color }} />
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-ink-faint">
                {c.done}/{c.total}
              </span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * Milestones: a project's product stages in roadmap order (Visibility → MVP →
 * …), each with how much of its content is delivered, the target against the
 * pace's forecast, and what it's still waiting on. Click one for its page.
 */
export function MilestonesView({
  bundle,
  items,
  projects,
  projectId,
  onOpen,
}: {
  bundle: MilestoneBundle;
  items: WorkItem[];
  projects: WorkProject[];
  projectId?: string;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("live");
  const [adding, setAdding] = useState(false);
  const { stats } = useMilestoneStats(bundle, items);
  const names = useMemo(() => new Map(bundle.milestones.map((m) => [m.id, m.name])), [bundle.milestones]);
  const byProject = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const shown = orderMilestones(bundle.milestones).filter((m) => inFilter(m, filter));
  const groups = new Map<string, MilestoneInfo[]>();
  for (const m of shown) groups.set(projectId ? "" : m.projectId, [...(groups.get(projectId ? "" : m.projectId) ?? []), m]);
  const count = (f: Filter) => bundle.milestones.filter((m) => inFilter(m, f)).length;
  const late = bundle.milestones.filter((m) => stats.get(m.id)?.outlook === "late").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="wk-tabs" role="tablist" aria-label="Which milestones">
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
            <Plus className="size-3.5" /> New milestone
          </button>
        )}
      </div>

      {adding && projectId && (
        <NewMilestone
          projectId={projectId}
          onCancel={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            onOpen(id);
          }}
        />
      )}

      {shown.length === 0 && !adding && (
        <div className="glass flex flex-col items-center gap-2 rounded-2xl px-5 py-10 text-center">
          <Flag className="size-5 text-ink-faint" aria-hidden />
          <p className="max-w-md text-sm text-ink-dim">
            {bundle.milestones.length === 0
              ? "No milestones yet. A milestone is a product stage, such as Visibility or the MVP. It's built from capabilities and the modules, items and other work that deliver them."
              : "Nothing here with this filter."}
          </p>
          {bundle.milestones.length === 0 && (
            <p className="max-w-md text-xs text-ink-faint">
              {projectId ? "Create one with New milestone. " : "Create one on a project's Milestones tab. "}Agents can also create and fill milestones
              through the apOS MCP tools <code className="font-mono">milestones.create</code> and <code className="font-mono">milestones.addContent</code>.
            </p>
          )}
        </div>
      )}

      {[...groups.entries()].map(([pid, ms]) => (
        <section key={pid || "project"} className="flex flex-col gap-2.5">
          {pid && (
            <Link href={`/m/projects/${pid}?tab=milestones`} className="wk-sec-h w-fit transition hover:text-ink">
              {byProject.get(pid)?.name ?? "Unknown project"}
              <span className="tabular-nums">{ms.length}</span>
            </Link>
          )}
          <ol className="flex flex-col">
            {ms.map((m, i) => (
              <li key={m.id} className="relative flex gap-3">
                {/* The route: a node per stage, a rail between them — order is the point. */}
                <span className="relative flex w-4 shrink-0 justify-center" aria-hidden>
                  {i > 0 && <span className="absolute top-0 h-5 w-px bg-ion/20" />}
                  {i < ms.length - 1 && <span className="absolute top-5 bottom-0 w-px bg-ion/20" />}
                  <span
                    className="relative mt-[15px] size-2.5 rounded-full border-2"
                    style={{
                      borderColor: OUTLOOK_META[stats.get(m.id)!.outlook].color,
                      background: m.status === "done" ? OUTLOOK_META.done.color : "var(--color-void)",
                    }}
                  />
                </span>
                <div className={cn("min-w-0 flex-1", i < ms.length - 1 && "pb-3")}>
                  <MilestoneCard m={m} s={stats.get(m.id)!} names={names} onOpen={() => onOpen(m.id)} />
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

// ── one milestone ───────────────────────────────────────────────────────────

/** Scope against done over time, with the pace's projection out to the forecast and the target line. */
function ScopeChart({ m, s, now }: { m: MilestoneInfo; s: MilestoneStats; now: number }) {
  const pts = s.burnup;
  if (pts.length < 2)
    return (
      <div className="grid h-[150px] place-items-center rounded-lg border border-dashed border-ion/15 text-xs text-ink-faint">
        The chart fills in as days pass.
      </div>
    );
  const from = pts[0].t;
  const target = m.targetAt ? +m.targetAt : null;
  const forecastAt = s.forecastAt != null && s.open > 0 ? s.forecastAt : null;
  // The future gets at most as much room as the history (a week at least), so a
  // far-off target doesn't flatten the delivered part into a sliver; what lies
  // beyond is clipped to the edge and named in the legend.
  const to = Math.min(Math.max(now, target ?? now, forecastAt ?? now), now + Math.max(now - from, 7 * DAY));
  const targetOff = target != null && target > to;
  const last = pts[pts.length - 1];
  // The pace line, cut where the chart ends when it lands beyond.
  const forecast =
    forecastAt != null
      ? { t: Math.min(forecastAt, to), v: last.done + ((last.scope - last.done) * (Math.min(forecastAt, to) - last.t)) / Math.max(1, forecastAt - last.t) }
      : null;
  const W = 300;
  const H = 150;
  const top = Math.max(1, ...pts.map((p) => p.scope));
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * W;
  const y = (v: number) => 6 + (1 - v / top) * (H - 12);
  const line = (k: "scope" | "done") => pts.map((p) => `${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[150px] w-full overflow-visible" role="img" aria-label={`${last.done} of ${last.scope} delivered`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={6 + f * (H - 12)} y2={6 + f * (H - 12)} stroke="color-mix(in oklab, var(--color-ion) 10%, transparent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {target != null && !targetOff && (
          <line x1={x(target)} x2={x(target)} y1="0" y2={H} stroke="var(--color-solar)" strokeOpacity="0.7" strokeDasharray="2 3" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        )}
        <polyline points={line("scope")} fill="none" stroke="color-mix(in oklab, var(--color-ink) 35%, transparent)" strokeWidth="1.3" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <polygon points={`${x(from)},${H} ${line("done")} ${x(last.t)},${H}`} fill="color-mix(in oklab, var(--color-plasma) 14%, transparent)" />
        <polyline points={line("done")} fill="none" stroke="var(--color-plasma)" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {forecast != null && (
          <line x1={x(last.t)} y1={y(last.done)} x2={x(forecast.t)} y2={y(forecast.v)} stroke="var(--color-plasma)" strokeOpacity="0.55" strokeDasharray="4 4" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        )}
        <circle cx={x(last.t)} cy={y(last.done)} r="3" fill="var(--color-plasma)" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-3 rounded bg-plasma" /> delivered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-0 w-3 border-t border-dashed border-ink/40" /> scope
        </span>
        {forecast != null && (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0 w-3 border-t border-dashed border-plasma/60" /> median forecast
          </span>
        )}
        {target != null && (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-0 border-l border-dashed border-solar/70" /> target{targetOff && ` ${shortDate(new Date(target))} →`}
          </span>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string; title?: string }) {
  return (
    <div title={title} className="flex min-w-0 flex-col gap-1 rounded-xl border border-ion/10 bg-ink/[0.03] px-3.5 py-3">
      <span className="wk-sec-h !text-[10px]">{label}</span>
      <span className="font-display text-[22px] leading-none tabular-nums text-ink" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
      {sub && <span className="text-[11.5px] tabular-nums text-ink-faint">{sub}</span>}
    </div>
  );
}

/** Under the forecast date: the pessimistic end, the gap to target, and what it rests on. */
function ForecastSub({ m, s }: { m: MilestoneInfo; s: MilestoneStats }) {
  if (s.forecastAt == null) return <>nothing closed in {s.basis.days} days</>;
  const gap = m.targetAt && !s.forecastBeyond ? Math.round((s.forecastAt - +m.targetAt) / DAY) : null;
  const rested = `${s.basis.closes} close${s.basis.closes === 1 ? "" : "s"} in ${s.basis.days} days`;
  return (
    <>
      <span className="block">
        {s.forecastLate != null ? `85% by ${shortDate(new Date(s.forecastLate))}` : "85%: 3 yrs+"}
        {gap != null && (gap > 0 ? ` · ${gap} days after target` : ` · ${-gap} days to spare`)}
      </span>
      <span className={cn("block", s.basis.low && "text-solar/80")}>{s.basis.low ? `low confidence · ${rested}` : rested}</span>
    </>
  );
}

const LEFT_ORDER: TaskStatus[] = ["review", "doing", "todo", "backlog"];

/** A capability's name, edited in place (saved on blur / Enter). */
function CapabilityName({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [v, setV] = useState(name);
  return (
    <input
      dir="auto"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => (v.trim() && v.trim() !== name ? onSave(v) : setV(name))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Capability name"
      className="-ml-1 min-w-0 flex-1 rounded-md bg-transparent px-1 font-display text-[15px] text-ink outline-none transition hover:bg-ink/4 focus:bg-ink/6"
    />
  );
}

/**
 * A milestone's page: goal, the numbers that say whether it lands (progress,
 * target, forecast, pace), the readiness gate, each capability with its
 * content, scope against delivery over time, and what's left.
 */
export function MilestonePage({
  m,
  bundle,
  items,
  features,
  onBack,
  onOpenItem,
  onOpenModule,
  onOpenMilestone,
}: {
  m: MilestoneInfo;
  bundle: MilestoneBundle;
  items: WorkItem[];
  features: WorkFeature[];
  onBack: () => void;
  onOpenItem: (id: string) => void;
  onOpenModule: (id: string) => void;
  onOpenMilestone: (id: string) => void;
}) {
  const now = useNow();
  const { resolve, stats } = useMilestoneStats(bundle, items);
  const s = stats.get(m.id)!;
  const scope = useMemo(() => resolve(m.id), [resolve, m.id]);
  const [showAllLeft, setShowAllLeft] = useState(false);
  const { pending, write } = useMilestoneWrite();
  const [name, setName] = useState(m.name);
  const [desc, setDesc] = useState(m.description ?? "");
  const [editingDesc, setEditingDesc] = useState(false);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  // Which capability's content picker is open ("loose" = ungrouped content).
  const [picker, setPicker] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [seed, setSeed] = useState(m);
  if (seed !== m) {
    setSeed(m);
    setName(m.name);
    setDesc(m.description ?? "");
  }
  const arm = (k: string) => {
    setArmed(k);
    setTimeout(() => setArmed((a) => (a === k ? null : a)), 4000);
  };
  const save = (patch: Parameters<typeof updateMilestoneAction>[1], failed = "Couldn't save the milestone") =>
    write(() => updateMilestoneAction(m.id, patch), failed);
  const remove = (r: Pick<ContentInfo, "kind" | "targetId">, failed = "Couldn't remove it") =>
    write(() => removeMilestoneContent(m.id, [{ kind: r.kind, targetId: r.targetId }]), failed);
  const day = (v: string) => (v ? new Date(`${v}T12:00:00`) : null);
  const itemById = useMemo(() => new Map(items.map((t) => [t.id, t])), [items]);
  const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const msById = useMemo(() => new Map(bundle.milestones.map((x) => [x.id, x])), [bundle.milestones]);
  const rows = bundle.content.filter((r) => r.milestoneId === m.id);
  const included = rows.filter((r) => !r.exclude);
  const excluded = rows.filter((r) => r.exclude);
  const capIds = new Set(bundle.capabilities.filter((c) => c.milestoneId === m.id).map((c) => c.id));
  const rowsOfCap = (id: string | null) => included.filter((r) => (id ? r.capabilityId === id : !r.capabilityId || !capIds.has(r.capabilityId)));

  // In-scope items per module, so a module row says how much of it this milestone takes.
  const inScopeByModule = new Map<string, { total: number; done: number }>();
  for (const x of scope.items) {
    const k = x.item.featureRef?.startsWith("features:") ? x.item.featureRef.slice(9) : "";
    const c = inScopeByModule.get(k) ?? { total: 0, done: 0 };
    c.total++;
    if (x.item.status === "done") c.done++;
    inScopeByModule.set(k, c);
  }

  const left = scope.items.map((x) => x.item).filter((t) => t.status !== "done");
  left.sort((a, b) => LEFT_ORDER.indexOf(a.status) - LEFT_ORDER.indexOf(b.status));
  const leftShown = showAllLeft ? left : left.slice(0, 15);
  const openEntities = scope.entities.filter((e) => !e.done);

  const daysToTarget = m.targetAt ? Math.ceil((+m.targetAt - now) / DAY) : null;
  const targetTone = s.outlook === "late" ? "var(--color-flare)" : s.outlook === "at-risk" || s.outlook === "stalled" ? "var(--color-solar)" : undefined;

  const contentRow = (r: ContentInfo) => {
    if (r.kind === "module") {
      const f = featureById.get(r.targetId);
      const c = inScopeByModule.get(r.targetId);
      return (
        <button type="button" onClick={() => onOpenModule(r.targetId)} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-ink/[0.04]">
          <Diamond className="size-3.5 shrink-0 text-solar" fill="currentColor" fillOpacity={0.25} aria-hidden />
          <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-ink group-hover:text-plasma">
            {f?.name ?? "Deleted module"}
          </span>
          <span className="shrink-0 text-[10.5px] uppercase tracking-wider text-ink-faint">whole module</span>
          <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-dim">{c ? `${c.done}/${c.total}` : "0"}</span>
        </button>
      );
    }
    if (r.kind === "item") {
      const t = itemById.get(r.targetId);
      return (
        <button
          type="button"
          onClick={() => t && onOpenItem(t.id)}
          disabled={!t}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-ink/[0.04]"
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: t ? STATUS_META[t.status].color : "var(--color-ink-faint)" }} title={t ? STATUS_META[t.status].label : undefined} />
          <span className="w-[74px] shrink-0 truncate font-mono text-[11px] text-ink-faint">{t?.identifier ?? "—"}</span>
          <span dir="auto" className={cn("min-w-0 flex-1 truncate text-[13px] text-ink group-hover:text-plasma", t?.status === "done" && "text-ink-dim")}>
            {t ? (t.shortTitle ?? t.title) : "Deleted item"}
          </span>
        </button>
      );
    }
    if (r.kind === "milestone") {
      const x = msById.get(r.targetId);
      const xs = x ? stats.get(x.id) : undefined;
      return (
        <button type="button" onClick={() => x && onOpenMilestone(x.id)} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-ink/[0.04]">
          <MilestoneGlyph outlook={xs?.outlook ?? "unscheduled"} size={13} />
          <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-ink group-hover:text-plasma">
            {x?.name ?? "Deleted milestone"}
          </span>
          <span className="shrink-0 text-[10.5px] uppercase tracking-wider text-ink-faint">milestone</span>
          <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-dim">{xs ? `${xs.pct}%` : "—"}</span>
        </button>
      );
    }
    const label = (
      <>
        <span className="w-[74px] shrink-0 truncate font-mono text-[10.5px] uppercase tracking-wider text-ink-faint">{r.entityKind}</span>
        <span dir="auto" className={cn("min-w-0 flex-1 truncate text-[13px]", r.done ? "text-ink-dim" : "text-ink")}>
          {r.label ?? r.targetId}
        </span>
      </>
    );
    return (
      <span className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-ink/[0.04]">
        {/* An entity has no state of its own: its done mark lives on the content row. */}
        <button
          type="button"
          onClick={() =>
            write(
              () => addMilestoneContent(m.id, [{ kind: "entity", targetId: r.targetId, entityKind: r.entityKind, label: r.label }], { done: !r.done }),
              "Couldn't mark it",
            )
          }
          aria-label={r.done ? `Mark "${r.label ?? r.targetId}" as not done` : `Mark "${r.label ?? r.targetId}" as done`}
          className="shrink-0 rounded transition hover:scale-110"
        >
          {r.done ? <Check className="size-3.5 text-plasma" /> : <Circle className="size-3.5 text-ink-faint" />}
        </button>
        {r.href ? (
          <Link href={r.href} className="group flex min-w-0 flex-1 items-center gap-2.5 hover:[&>span:last-child]:text-plasma">
            {label}
          </Link>
        ) : (
          label
        )}
      </span>
    );
  };

  /** A content row with its hover action: remove it, or bring an exclusion back into scope. */
  const withRemove = (r: ContentInfo) => (
    <li key={r.id} className="group/row flex items-center gap-1">
      <div className="min-w-0 flex-1">{contentRow(r)}</div>
      <button
        type="button"
        disabled={pending}
        onClick={() => remove(r, r.exclude ? "Couldn't bring it back" : "Couldn't remove it")}
        aria-label={r.exclude ? "Bring back into scope" : "Remove from this milestone"}
        title={r.exclude ? "Bring back into scope" : "Remove from this milestone (the work itself stays)"}
        className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition group-hover/row:opacity-100 hover:text-flare focus-visible:opacity-100"
      >
        {r.exclude ? <Plus className="size-3.5" /> : <X className="size-3.5" />}
      </button>
    </li>
  );
  const pickerFor = (key: string, capabilityId: string | null) =>
    picker === key && (
      <ContentPicker m={m} capabilityId={capabilityId} bundle={bundle} items={items} features={features} onClose={() => setPicker(null)} />
    );

  return (
    <div className="flex flex-col gap-4">
      <section aria-label={m.name} className={cn("glass flex flex-col gap-4 rounded-2xl p-5", pending && "opacity-80")}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" onClick={onBack} className="wk-btn !px-2 !py-1 text-xs" aria-label="Back to milestones">
            <ArrowLeft className="size-3.5" /> Milestones
          </button>
          <MilestoneGlyph outlook={s.outlook} size={17} />
          <input
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => (name.trim() && name.trim() !== m.name ? save({ name }, "Couldn't rename the milestone") : setName(m.name))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Milestone name"
            size={Math.max(6, Math.min(48, name.length + 1))}
            className="min-w-0 max-w-full rounded-lg bg-transparent px-1 font-display text-[22px] leading-tight text-ink outline-none transition hover:bg-ink/4 focus:bg-ink/6"
          />
          <OutlookChip outlook={s.outlook} />
          <select
            value={m.status}
            onChange={(e) => save({ status: e.target.value as MilestoneStatus })}
            aria-label="Milestone state"
            className="wk-chip !px-2 !py-px !text-[11px] capitalize transition hover:text-ink"
          >
            {MILESTONE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {st === "done" ? "reached" : st}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending}
            onClick={() => (armed === "delete" ? write(() => deleteMilestoneAction(m.id), "Couldn't delete the milestone", onBack) : arm("delete"))}
            className={cn("wk-btn ml-auto !py-1 text-xs", armed === "delete" ? "!border-flare/50 text-flare" : "!px-2 text-ink-faint hover:text-flare")}
            title="Delete the milestone (the work in it stays)"
            aria-label={`Delete ${m.name}`}
          >
            <Trash2 className="size-3.5" />
            {armed === "delete" && "Click again to delete"}
          </button>
        </header>

        <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,1fr)]">
          <div className="min-w-0">
            {editingDesc ? (
              <textarea
                autoFocus
                dir="auto"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onBlur={() => {
                  setEditingDesc(false);
                  if (desc.trim() !== (m.description ?? "").trim()) save({ description: desc }, "Couldn't save the goal");
                }}
                onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
                placeholder="The goal: what reaching this stage means (markdown)"
                aria-label="Goal"
                className="max-h-[50vh] min-h-24 w-full resize-y rounded-lg bg-ink/4 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink-dim outline-none placeholder:text-ink-faint focus:bg-ink/6"
              />
            ) : desc ? (
              <div className="group relative max-w-3xl text-sm leading-relaxed text-ink-dim" onDoubleClick={() => setEditingDesc(true)} title="Double-click to edit">
                <Markdown size="note">{desc}</Markdown>
                <button
                  type="button"
                  onClick={() => setEditingDesc(true)}
                  className="absolute -top-1 right-0 inline-flex items-center gap-1 text-xs text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
                >
                  <Pencil className="size-3" /> Edit
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setEditingDesc(true)} className="text-[13px] text-ink-faint transition hover:text-ink-dim">
                Add a goal: what reaching this stage means…
              </button>
            )}
          </div>
          <dl className="wk-props">
            <dt>Target</dt>
            <dd>
              <input
                type="date"
                value={m.targetAt ? dateInput(m.targetAt) : ""}
                onChange={(e) => save({ targetAt: day(e.target.value) }, "Couldn't set the target")}
                aria-label="Target date"
                className={cn("wk-inline", s.outlook === "late" && "!text-flare")}
              />
            </dd>
            <dt>Waits on</dt>
            <dd>
              <RequiresEditor m={m} bundle={bundle} />
            </dd>
          </dl>
        </div>

        {s.waitingOn.length > 0 && (
          <div className="wk-read flare">
            <b>Waiting on</b>{" "}
            {s.waitingOn.map((w, i) => (
              <Fragment key={w.id}>
                {i > 0 && ", "}
                <button type="button" onClick={() => onOpenMilestone(w.id)} className="text-ink underline decoration-dotted underline-offset-2 hover:text-plasma">
                  {w.name}
                </button>{" "}
                ({w.pct}% delivered)
              </Fragment>
            ))}{" "}
            — {s.waitingOn.length > 1 ? "they have" : "it has"} to be reached before this one.
          </div>
        )}

        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
          <Tile label="Delivered" value={s.total ? `${s.pct}%` : "—"} sub={`${s.done} of ${s.total}${s.entities.total ? ` · ${s.entities.total} non-item` : ""}`} />
          <Tile
            label="Target"
            value={m.targetAt ? shortDate(m.targetAt) : "—"}
            sub={daysToTarget == null ? "not set" : daysToTarget >= 0 ? `${daysToTarget} days left` : `${-daysToTarget} days ago`}
            tone={targetTone}
          />
          <Tile
            label="Forecast"
            value={s.open === 0 ? "done" : s.forecastBeyond ? "3 yrs+" : s.forecastAt != null ? shortDate(new Date(s.forecastAt)) : "—"}
            sub={s.open > 0 && <ForecastSub m={m} s={s} />}
            tone={targetTone}
            title="Median of 500 simulated runs that replay this milestone's daily closes (imports left out) until the open work runs out. Items in progress count half done, in review 80%."
          />
          <Tile label="Left" value={s.open} sub={`${s.by.doing + s.by.review} moving · ${s.by.todo + s.by.backlog + openEntities.length} not started`} />
          {s.criteria.total > 0 && <Tile label="Exit criteria" value={`${s.criteria.done}/${s.criteria.total}`} sub="met" />}
        </div>

        <div className="flex flex-col gap-2">
          <MilestoneBar s={s} big />
          <BarLegend s={s} />
        </div>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-2 px-1">
            <h3 className="wk-sec-h">
              Capabilities <span className="tabular-nums">{s.capabilities.filter((c) => c.id).length}</span>
            </h3>
            <button type="button" onClick={() => setCapDraft(capDraft == null ? "" : null)} className="wk-btn ml-auto !py-1 text-xs">
              <Plus className="size-3.5" /> Capability
            </button>
          </div>
          {capDraft != null && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!capDraft.trim()) return;
                write(
                  () => saveCapability(m.id, null, { name: capDraft }),
                  "Couldn't add the capability",
                  (r) => {
                    setCapDraft(null);
                    if (r.ok) setPicker(r.id);
                  },
                );
              }}
              className="glass flex items-center gap-2 rounded-2xl p-2.5 pl-4"
            >
              <input
                autoFocus
                dir="auto"
                value={capDraft}
                onChange={(e) => setCapDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setCapDraft(null)}
                placeholder="Capability name, such as AI visibility"
                aria-label="Capability name"
                className="h-8 flex-1 bg-transparent font-display text-[15px] text-ink outline-none placeholder:font-sans placeholder:text-sm placeholder:text-ink-faint"
              />
              <button type="submit" disabled={pending || !capDraft.trim()} className="wk-btn primary !py-1.5 text-xs">
                Add
              </button>
              <button type="button" onClick={() => setCapDraft(null)} className="wk-btn !py-1.5 text-xs">
                Cancel
              </button>
            </form>
          )}
          {s.capabilities.length === 0 && (
            <div className="glass flex flex-col gap-3 rounded-2xl px-5 py-5">
              <p className="text-sm text-ink-faint">
                No content yet. Group it into capabilities, or add modules, items, other milestones and anything else in apOS directly.
              </p>
              {picker === "loose" ? (
                pickerFor("loose", null)
              ) : (
                <button type="button" onClick={() => setPicker("loose")} className="wk-btn primary self-start !py-1 text-xs">
                  <Plus className="size-3.5" /> Add content
                </button>
              )}
            </div>
          )}
          {s.capabilities.map((c) => {
            const list = rowsOfCap(c.id);
            const key = c.id ?? "loose";
            return (
              <section key={key} className="glass flex flex-col gap-2.5 rounded-2xl p-4">
                <header className="group flex items-center gap-3">
                  {c.id ? (
                    <CapabilityName key={c.name} name={c.name} onSave={(n) => write(() => saveCapability(m.id, c.id, { name: n }), "Couldn't rename the capability")} />
                  ) : (
                    <span dir="auto" className="min-w-0 flex-1 font-display text-[15px] text-ink">
                      {c.name}
                    </span>
                  )}
                  {c.id && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => (armed === `cap:${c.id}` ? write(() => deleteCapability(m.id, c.id!), "Couldn't delete the capability") : arm(`cap:${c.id}`))}
                      className={cn(
                        "shrink-0 rounded-md p-1 text-xs transition",
                        armed === `cap:${c.id}` ? "text-flare" : "text-ink-faint opacity-0 hover:text-flare group-hover:opacity-100 focus-visible:opacity-100",
                      )}
                      title="Delete the capability (its content stays in the milestone, ungrouped)"
                      aria-label={`Delete capability ${c.name}`}
                    >
                      {armed === `cap:${c.id}` ? "Click again to delete" : <Trash2 className="size-3.5" />}
                    </button>
                  )}
                  <span className="font-mono text-[11.5px] tabular-nums text-ink-dim">
                    {c.done}/{c.total}
                  </span>
                  <span className="w-10 text-right font-display text-[15px] tabular-nums text-ink">{c.total ? `${c.pct}%` : "—"}</span>
                </header>
                <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
                  <span className="block h-full rounded-full" style={{ width: `${c.pct}%`, background: STATUS_META.done.color }} />
                </div>
                {c.description && <p className="text-[12.5px] leading-relaxed text-ink-dim">{c.description}</p>}
                {list.length > 0 && <ul className="-mx-2 flex flex-col">{list.map(withRemove)}</ul>}
                {picker === key ? (
                  pickerFor(key, c.id)
                ) : (
                  <button
                    type="button"
                    onClick={() => setPicker(key)}
                    className="inline-flex items-center gap-1.5 self-start rounded-md px-1 text-[12px] text-ink-faint transition hover:text-ink"
                  >
                    <Plus className="size-3.5" /> Add content
                  </button>
                )}
              </section>
            );
          })}
          {excluded.length > 0 && (
            <section className="flex flex-col gap-1.5 rounded-2xl border border-dashed border-ion/15 p-4">
              <h4 className="wk-sec-h">
                <MinusCircle className="size-3" /> Left out of scope <span className="tabular-nums">{excluded.length}</span>
              </h4>
              <ul className="-mx-2 flex flex-col [&_span.flex-1]:line-through [&_span.flex-1]:opacity-70">{excluded.map(withRemove)}</ul>
            </section>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <section className="glass flex flex-col gap-3 rounded-2xl p-4">
            <h3 className="wk-sec-h">Scope and delivery</h3>
            <ScopeChart m={m} s={s} now={now} />
          </section>

          <section className="glass flex flex-col gap-2 rounded-2xl p-4">
            <h3 className="wk-sec-h">
              Exit criteria {s.criteria.total > 0 && <span className="tabular-nums">{s.criteria.done}/{s.criteria.total}</span>}
            </h3>
            <CriteriaEditor m={m} />
          </section>

          {s.modules.length > 0 && (
            <section className="glass flex flex-col gap-2 rounded-2xl p-4">
              <h3 className="wk-sec-h">By module</h3>
              <ul className="flex flex-col gap-1.5">
                {s.modules.map((x) => (
                  <li key={x.id || "none"}>
                    <button
                      type="button"
                      disabled={!x.id}
                      onClick={() => x.id && onOpenModule(x.id)}
                      className="group flex w-full items-center gap-2.5 text-left text-[12.5px]"
                    >
                      <span dir="auto" className="min-w-0 flex-1 truncate text-ink-dim group-enabled:group-hover:text-plasma">
                        {x.id ? (featureById.get(x.id)?.name ?? "Deleted module") : "In no module"}
                      </span>
                      <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-ink/[0.08]">
                        <span className="block h-full rounded-full" style={{ width: `${x.pct}%`, background: STATUS_META.done.color }} />
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-faint">
                        {x.done}/{x.total}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="glass flex flex-col gap-2 rounded-2xl p-4">
            <h3 className="wk-sec-h">
              What&apos;s left <span className="tabular-nums">{left.length + openEntities.length}</span>
            </h3>
            {left.length + openEntities.length === 0 ? (
              <p className="text-[13px] text-ink-faint">{s.total ? "Everything in scope is delivered." : "Nothing in scope yet."}</p>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {leftShown.map((t) => (
                  <li key={t.id} className="group/row flex items-center gap-1">
                    <button type="button" onClick={() => onOpenItem(t.id)} className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-ink/[0.04]">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_META[t.status].color }} title={STATUS_META[t.status].label} />
                      <span className="w-[74px] shrink-0 truncate font-mono text-[11px] text-ink-faint">{t.identifier ?? "—"}</span>
                      <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-ink group-hover:text-plasma">
                        {t.shortTitle ?? t.title}
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" aria-hidden />
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => write(() => addMilestoneContent(m.id, [{ kind: "item", targetId: t.id }], { exclude: true }), "Couldn't leave it out")}
                      aria-label={`Leave ${t.identifier ?? "this item"} out of scope`}
                      title="Leave out of this milestone's scope"
                      className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition group-hover/row:opacity-100 hover:text-flare focus-visible:opacity-100"
                    >
                      <MinusCircle className="size-3.5" />
                    </button>
                  </li>
                ))}
                {showAllLeft &&
                  openEntities.map((e) => (
                    <li key={e.id}>{contentRow(e)}</li>
                  ))}
              </ul>
            )}
            {left.length + openEntities.length > leftShown.length + (showAllLeft ? openEntities.length : 0) && (
              <button type="button" onClick={() => setShowAllLeft(true)} className="self-start text-[12px] text-ink-dim underline decoration-dotted underline-offset-2 hover:text-ink">
                Show all {left.length + openEntities.length}
              </button>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

// ── the Overview strip ──────────────────────────────────────────────────────

/** The project's stages in order on its Overview — each links to its page. */
export function MilestoneStrip({ bundle, items }: { bundle: MilestoneBundle; items: WorkItem[] }) {
  const { stats } = useMilestoneStats(bundle, items);
  const ms = orderMilestones(bundle.milestones).filter((m) => m.status !== "cancelled");
  if (!ms.length) return null;
  return (
    <section aria-label="Milestones" className="glass flex flex-col gap-3 rounded-2xl p-5">
      <header className="flex items-center gap-2">
        <h3 className="wk-sec-h">
          <Flag className="size-3" /> Milestones
        </h3>
        <Link href="?tab=milestones" className="ml-auto text-[11.5px] text-ink-faint transition hover:text-ink">
          All milestones
        </Link>
      </header>
      <ol className="flex flex-wrap items-stretch gap-2">
        {ms.map((m, i) => {
          const s = stats.get(m.id)!;
          return (
            <li key={m.id} className="flex min-w-[180px] flex-1 items-center gap-2">
              {i > 0 && <ArrowRight className="size-3.5 shrink-0 text-ink-faint" aria-hidden />}
              <Link
                href={`?tab=milestones&milestone=${m.id}`}
                className="group flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-ion/10 bg-ink/[0.03] p-3 transition hover:border-ion/25"
              >
                <span className="flex items-center gap-2">
                  <MilestoneGlyph outlook={s.outlook} size={13} />
                  <span dir="auto" className="min-w-0 flex-1 truncate text-[13.5px] text-ink group-hover:text-plasma">
                    {m.name}
                  </span>
                  <span className="font-display text-[15px] tabular-nums text-ink">{s.total ? `${s.pct}%` : "—"}</span>
                </span>
                <MilestoneBar s={s} />
                <span className="flex items-center justify-between gap-2 text-[11px]">
                  <span style={{ color: OUTLOOK_META[s.outlook].color }}>{OUTLOOK_META[s.outlook].label}</span>
                  <span className="font-mono tabular-nums text-ink-faint">{m.targetAt ? shortDate(m.targetAt) : "no target"}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
