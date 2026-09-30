"use client";

import { useMemo } from "react";
import { shortDate, timeAgo } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import type { CycleSummary } from "../cycles";
import type { WorkItem } from "../core";
import type { WorkData } from "../queries";
import { moduleStats } from "./ModulesView";
import { isClosed } from "./work-ui";

const DAY = 86_400_000;

/** Remaining work per day against the ideal straight line, drawn to fill its box. */
function Burn({ c }: { c: CycleSummary }) {
  const days = Math.max(2, Math.round((+new Date(c.endsAt) - +new Date(c.startsAt)) / DAY) + 1);
  const pts = c.burndown;
  if (!pts.length) return null;
  const top = Math.max(1, ...pts.map((p) => p.remaining));
  const W = 300;
  const H = 46;
  const X = (i: number) => (i / (days - 1)) * W;
  const Y = (v: number) => 4 + (1 - v / top) * (H - 8);
  const line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.remaining).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="mt-1 block h-[46px] w-full overflow-visible"
      role="img"
      aria-label={`Burndown: ${last.remaining} of ${top} items still open`}
    >
      <polyline
        points={`0,${Y(pts[0].remaining)} ${W},${Y(0)}`}
        fill="none"
        stroke="color-mix(in oklab, var(--color-ink) 22%, transparent)"
        strokeDasharray="3 3"
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={`0,${H} ${line} ${X(pts.length - 1)},${H}`} fill="color-mix(in oklab, var(--color-plasma) 14%, transparent)" />
      <polyline points={line} fill="none" stroke="var(--color-plasma)" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(pts.length - 1)} cy={Y(last.remaining)} r="3" fill="var(--color-plasma)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const SEGMENTS = [
  { status: "done", label: "done", color: "var(--color-plasma)" },
  { status: "review", label: "review", color: "var(--color-violet)" },
  { status: "doing", label: "doing", color: "var(--color-solar)" },
] as const;

/**
 * The project's (or all work's) pulse, above the views: the running cycle's
 * progress and burndown, the modules closest to their target, and a short
 * read of pace, risk and repo activity. The read is computed from the data —
 * no model call — so it is always current and never invents anything.
 */
export function CycleStrip({
  data,
  items,
  onOpenCycle,
  onOpenModule,
  onOpenItem,
  onPlanCycle,
}: {
  data: WorkData;
  /** Items in scope (the project's, or everything). */
  items: WorkItem[];
  onOpenCycle: (id: string) => void;
  onOpenModule: (id: string) => void;
  onOpenItem: (id: string) => void;
  onPlanCycle: () => void;
}) {
  const now = useNow();
  const cycle = data.cycles.find((c) => c.status === "current") ?? null;
  const stats = useMemo(() => moduleStats(items), [items]);
  const byId = useMemo(() => new Map(items.map((t) => [t.id, t])), [items]);
  const projectKey = useMemo(() => new Map(data.projects.map((p) => [p.id, p.key ?? p.name])), [data.projects]);
  const multiProject = new Set(data.features.map((f) => f.projectId)).size > 1;

  // ── cycle ──
  const inCycle = cycle ? items.filter((t) => t.cycleId === cycle.id && t.status !== "cancelled") : [];
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
  const unit = usePts ? "pts" : "items";
  const daysLeft = cycle ? Math.max(0, Math.ceil((+new Date(cycle.endsAt) + DAY - now) / DAY)) : 0;

  // ── milestones: live modules, nearest target first ──
  const milestones = data.features
    .filter((f) => f.status === "active" || f.status === "planned" || f.status === "paused")
    .filter((f) => (stats.get(f.id)?.total ?? 0) > 0 || f.targetAt)
    .sort(
      (a, b) =>
        (a.targetAt ? +new Date(a.targetAt) : Infinity) - (b.targetAt ? +new Date(b.targetAt) : Infinity) ||
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
        a.sortOrder - b.sortOrder,
    )
    .slice(0, 4);

  // ── the read ──
  const open = items.filter((t) => !isClosed(t.status));
  const overdue = open
    .filter((t) => t.dueAt && +new Date(t.dueAt) + DAY < now)
    .sort((a, b) => +new Date(a.dueAt!) - +new Date(b.dueAt!));
  const blocked = open.filter((t) => data.blocked.includes(t.id));
  const closedLastWeek = items.filter((t) => t.status === "done" && t.completedAt && now - +new Date(t.completedAt) < 7 * DAY).length;
  const pace = closedLastWeek / 7;
  const cycleOpen = inCycle.filter((t) => !isClosed(t.status)).length;
  const need = daysLeft > 0 ? cycleOpen / daysLeft : cycleOpen;
  const scopeGrew = cycle && cycle.burndown.length ? Math.max(...cycle.burndown.map((p) => p.remaining)) - cycle.burndown[0].remaining : 0;
  const inReview = open.filter((t) => t.status === "review").length;
  const needsInput = Object.entries(data.delegated).filter(([id, s]) => s === "needs_input" && byId.has(id)).length;
  const commit = data.recentCommits[0];
  const commitItem = commit ? byId.get(commit.taskId) : undefined;
  const fmt = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ""));

  const link = "underline decoration-dotted underline-offset-2 transition hover:text-ink";

  return (
    <section
      aria-label="Cycle and milestones"
      className="glass grid gap-x-6 gap-y-5 rounded-2xl px-5 py-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.2fr)_minmax(200px,1fr)_minmax(240px,1.4fr)]"
    >
      {/* cycle */}
      <div className="min-w-0">
        {cycle ? (
          <>
            <h4 className="mb-1.5 flex flex-wrap items-baseline gap-x-2 font-display text-sm font-semibold tracking-[0.03em] text-ink">
              <button type="button" onClick={() => onOpenCycle(cycle.id)} className="truncate transition hover:text-plasma" dir="auto">
                {cycle.name}
              </button>
              <span className="font-mono text-xs font-normal tabular-nums text-ink-faint">
                {shortDate(cycle.startsAt)} – {shortDate(cycle.endsAt)} · {daysLeft} day{daysLeft === 1 ? "" : "s"} left
              </span>
            </h4>
            <div className="wk-bar" role="img" aria-label={`${by.done} of ${total} ${unit} done`}>
              {total > 0 &&
                SEGMENTS.map((s) => <b key={s.status} style={{ width: `${(by[s.status] / total) * 100}%`, background: s.color }} />)}
            </div>
            <div className="mt-[7px] flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-ink-dim">
              {SEGMENTS.map((s) => (
                <span key={s.status} className="inline-flex items-center gap-[5px]">
                  <i className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
                  {by[s.status]} {s.label}
                </span>
              ))}
              <span className="inline-flex items-center gap-[5px]">
                <i className="inline-block size-2 rounded-[2px] bg-ink/20" />
                {by.todo} todo
              </span>
              <span className="ml-auto">
                {total ? Math.round((by.done / total) * 100) : 0}% of {total} {unit}
              </span>
            </div>
            <Burn c={cycle} />
          </>
        ) : (
          <>
            <h4 className="mb-1.5 font-display text-sm font-semibold tracking-[0.03em] text-ink">No cycle running</h4>
            <p className="text-[12.5px] leading-relaxed text-ink-dim">
              A cycle is a 1–2 week time-box. Plan items into one to get a burndown and a pace read here.
            </p>
            <button type="button" onClick={onPlanCycle} className="wk-btn mt-3 !py-1 text-xs">
              Plan a cycle
            </button>
          </>
        )}
      </div>

      {/* milestones */}
      <div className="min-w-0">
        <h4 className="mb-1.5 font-display text-sm font-semibold tracking-[0.03em] text-ink">Milestones</h4>
        {milestones.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">No live modules. Group items into a module to track it here.</p>
        ) : (
          <div className="flex flex-col gap-[7px]">
            {milestones.map((f) => {
              const s = stats.get(f.id);
              const pct = s?.total ? Math.round((s.closed / s.total) * 100) : 0;
              const late = f.targetAt && +new Date(f.targetAt) + DAY < now;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onOpenModule(f.id)}
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 text-left text-[12.5px]"
                >
                  <span dir="auto" className="truncate text-ink-dim transition group-hover:text-ink">
                    {multiProject && <span className="text-ink-faint">{projectKey.get(f.projectId)} · </span>}
                    {f.name}
                  </span>
                  <em className={late ? "font-mono text-[11.5px] not-italic text-flare" : "font-mono text-[11.5px] not-italic text-ink-faint"}>
                    {f.targetAt ? `${shortDate(f.targetAt)} · ` : ""}
                    {pct}%
                  </em>
                  <span className="wk-bar col-span-2 !h-[5px]">
                    <b style={{ width: `${pct}%`, background: "var(--color-plasma)" }} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* read */}
      <div className="flex min-w-0 flex-col gap-2 md:col-span-2 xl:col-span-1">
        <h4 className="font-display text-sm font-semibold tracking-[0.03em] text-ink">Read</h4>
        <p className="wk-read">
          <b>Pace</b> ·{" "}
          {cycle ? (
            <>
              {cycleOpen} open in the cycle with {daysLeft} day{daysLeft === 1 ? "" : "s"} left
              {cycleOpen > 0 && daysLeft > 0 && (
                <>
                  {" "}
                  — needs ~{fmt(need)}/day against a recent pace of {fmt(pace)}/day
                </>
              )}
              .{scopeGrew > 0 && ` Scope grew by ${scopeGrew} since it started.`}
            </>
          ) : (
            <>
              {closedLastWeek} item{closedLastWeek === 1 ? "" : "s"} closed in the last 7 days.
            </>
          )}
        </p>
        <p className={overdue.length || blocked.length ? "wk-read flare" : "wk-read plasma"}>
          <b>Risk</b> ·{" "}
          {overdue.length || blocked.length ? (
            <>
              {overdue.length > 0 && (
                <>
                  {overdue.length} overdue (
                  <button type="button" className={link} onClick={() => onOpenItem(overdue[0].id)}>
                    {overdue[0].identifier}
                  </button>{" "}
                  by {Math.max(1, Math.floor((now - +new Date(overdue[0].dueAt!)) / DAY))}d)
                </>
              )}
              {overdue.length > 0 && blocked.length > 0 && " · "}
              {blocked.length > 0 && (
                <>
                  {blocked.length} blocked (
                  <button type="button" className={link} onClick={() => onOpenItem(blocked[0].id)}>
                    {blocked[0].identifier}
                  </button>
                  )
                </>
              )}
              .
            </>
          ) : (
            "nothing overdue or blocked."
          )}
          {inReview > 0 && ` ${inReview} waiting in review.`}
          {needsInput > 0 && ` ${needsInput} Workbench run${needsInput === 1 ? "" : "s"} need${needsInput === 1 ? "s" : ""} your input.`}
        </p>
        <p className="wk-read plasma">
          <b>Repo watcher</b> ·{" "}
          {commit ? (
            <>
              commit <span className="font-mono">{commit.ref.slice(0, 7)}</span>
              {commit.title && <> “{commit.title}”</>} linked to{" "}
              {commitItem ? (
                <button type="button" className={link} onClick={() => onOpenItem(commitItem.id)}>
                  {commitItem.identifier}
                </button>
              ) : (
                "an item"
              )}{" "}
              · {timeAgo(commit.at)}.
            </>
          ) : (
            <>no linked commits yet — mention an item&apos;s id (e.g. {items[0]?.identifier ?? "KEY-12"}) in a commit message to link it.</>
          )}
        </p>
      </div>
    </section>
  );
}
