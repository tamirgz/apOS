"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import {
  createCycleAction,
  deleteCycleAction,
  rollOverCycleAction,
  updateCycleAction,
} from "../actions";
import type { CycleStatus, CycleSummary } from "../cycles";
import type { WorkItem } from "../core";
import type { WorkProject } from "../queries";

const DAY = 86_400_000;

export const CYCLE_META: Record<CycleStatus, { label: string; color: string }> = {
  current: { label: "Current", color: "var(--color-ion)" },
  upcoming: { label: "Upcoming", color: "var(--color-ink-faint)" },
  completed: { label: "Completed", color: "var(--color-plasma)" },
};

export const dateInput = (d: Date | string | number) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/**
 * Remaining-items line against the ideal straight line. Scope added mid-cycle
 * makes the actual line step UP — that's the point of drawing it.
 */
export function Burndown({ c, width = 132, height = 34 }: { c: CycleSummary; width?: number; height?: number }) {
  const days = Math.max(1, Math.round((+new Date(c.endsAt) - +new Date(c.startsAt)) / DAY) + 1);
  const pts = c.burndown;
  if (!pts.length) return <div style={{ width, height }} aria-hidden />;
  const top = Math.max(1, ...pts.map((p) => p.remaining));
  const x = (i: number) => (days <= 1 ? 0 : (i / (days - 1)) * (width - 4)) + 2;
  const y = (v: number) => height - 3 - (v / top) * (height - 6);
  const actual = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.remaining).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className="block shrink-0" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Burndown: ${last.remaining} remaining`}>
      <line x1={x(0)} y1={y(pts[0].remaining)} x2={x(days - 1)} y2={y(0)} stroke="currentColor" strokeOpacity="0.18" strokeDasharray="3 3" />
      <path d={`${actual} L${x(pts.length - 1)},${height - 3} L${x(0)},${height - 3} Z`} fill="var(--color-ion)" fillOpacity="0.08" />
      <path d={actual} fill="none" stroke="var(--color-ion)" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={x(pts.length - 1)} cy={y(last.remaining)} r="2.5" fill="var(--color-ion)" />
    </svg>
  );
}

function CycleForm({
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  initial: { name: string; startsAt: string; endsAt: string };
  onSubmit: (v: { name: string; startsAt: string; endsAt: string }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [v, setV] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
      className="glass flex flex-wrap items-center gap-2 rounded-xl p-2"
    >
      <input
        autoFocus
        dir="auto"
        value={v.name}
        onChange={(e) => setV({ ...v, name: e.target.value })}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Cycle name — e.g. Sprint 15"
        aria-label="Cycle name"
        className="h-8 min-w-40 flex-1 rounded-lg bg-white/5 px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <input
        type="date"
        value={v.startsAt}
        onChange={(e) => setV({ ...v, startsAt: e.target.value })}
        aria-label="Starts"
        className="rounded-lg border border-white/8 bg-transparent px-2 py-1.5 text-xs text-ink-dim outline-none"
      />
      <ArrowRight className="size-3 text-ink-faint" />
      <input
        type="date"
        value={v.endsAt}
        onChange={(e) => setV({ ...v, endsAt: e.target.value })}
        aria-label="Ends"
        className="rounded-lg border border-white/8 bg-transparent px-2 py-1.5 text-xs text-ink-dim outline-none"
      />
      <button
        type="submit"
        disabled={pending || !v.name.trim()}
        className="rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
      >
        save
      </button>
    </form>
  );
}

function CycleRow({
  c,
  next,
  onSelect,
  projectName,
}: {
  c: CycleSummary;
  next: CycleSummary | null;
  onSelect: () => void;
  projectName: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const open = c.total - c.done;
  const daysLeft = Math.ceil((+new Date(c.endsAt) + DAY - now) / DAY);

  if (editing) {
    return (
      <CycleForm
        initial={{ name: c.name, startsAt: dateInput(c.startsAt), endsAt: dateInput(c.endsAt) }}
        pending={pending}
        onCancel={() => setEditing(false)}
        onSubmit={(v) => run(async () => (await updateCycleAction(c.id, v), setEditing(false)))}
      />
    );
  }

  return (
    <div className={cn("group glass flex flex-col gap-2 rounded-xl p-3 transition", pending && "opacity-50")}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left" title="Show this cycle's items on the board">
          <span
            className="shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest"
            style={{ color: CYCLE_META[c.status].color, borderColor: "color-mix(in oklab, currentColor 35%, transparent)" }}
          >
            {CYCLE_META[c.status].label}
          </span>
          <span dir="auto" className="min-w-0 truncate text-sm text-ink transition group-hover:text-ink">{c.name}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
            {shortDate(c.startsAt)} → {shortDate(c.endsAt)}
            {c.status === "current" && ` · ${daysLeft}d left`}
          </span>
          {projectName && <span className="shrink-0 font-mono text-[10px] text-ink-faint">{projectName}</span>}
        </button>
        <span className="hidden shrink-0 text-ink-faint sm:block">
          <Burndown c={c} />
        </span>
        <span className="flex w-36 shrink-0 flex-col gap-1">
          <span className="h-1 w-full overflow-hidden rounded-full bg-white/6" aria-hidden>
            <span className="block h-full rounded-full bg-plasma/70" style={{ width: `${pct}%` }} />
          </span>
          <span className="font-mono text-[10px] tabular-nums text-ink-faint">
            {c.done}/{c.total} items{c.points ? ` · ${c.pointsDone}/${c.points} pts` : ""}
          </span>
        </span>
        <span className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md p-1 text-ink-faint hover:text-ink" aria-label={`Edit ${c.name}`}>
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (!armed) {
                setArmed(true);
                setTimeout(() => setArmed(false), 3000);
                return;
              }
              run(() => deleteCycleAction(c.id));
            }}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] uppercase tracking-widest",
              armed ? "border border-flare/40 text-flare" : "text-ink-faint hover:text-flare",
            )}
            title="Delete cycle (its items stay, just un-planned)"
          >
            <Trash2 className="size-3.5" />
            {armed && "again"}
          </button>
        </span>
      </div>
      {c.status === "completed" && open > 0 && (
        <div className="flex items-center gap-2 border-t border-white/5 pt-2 text-xs text-ink-faint">
          <span>
            {open} item{open === 1 ? "" : "s"} didn&apos;t finish.
          </span>
          <button
            type="button"
            onClick={() => run(() => rollOverCycleAction(c.id, next?.id ?? null))}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/10"
          >
            <RefreshCw className="size-3" />
            {next ? `move to ${next.name}` : "un-plan them"}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-flare">{error}</p>}
    </div>
  );
}

/**
 * Cycles: time-boxed iterations with progress and a burndown. Click a cycle to
 * see its items on the board; a finished cycle offers to roll its leftovers
 * into the next one.
 */
export function CyclesView({
  cycles,
  projectId,
  projects,
  onSelect,
}: {
  cycles: CycleSummary[];
  items: WorkItem[];
  projectId?: string;
  projects: WorkProject[];
  onSelect: (cycleId: string) => void;
}) {
  const router = useRouter();
  const now = useNow();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectName = new Map(projects.map((p) => [p.id, p.key ?? p.name]));

  const order: CycleStatus[] = ["current", "upcoming", "completed"];
  const sorted = [...cycles].sort(
    (a, b) =>
      order.indexOf(a.status) - order.indexOf(b.status) ||
      (a.status === "completed" ? +new Date(b.startsAt) - +new Date(a.startsAt) : +new Date(a.startsAt) - +new Date(b.startsAt)),
  );
  const nextFor = (c: CycleSummary) =>
    cycles
      .filter((o) => o.id !== c.id && o.status !== "completed" && (o.projectId ?? null) === (c.projectId ?? null))
      .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0] ?? null;

  // Default a new cycle to start the day after the latest one ends (or today), two weeks long.
  const latestEnd = Math.max(0, ...cycles.map((c) => +new Date(c.endsAt)));
  const startDefault = latestEnd > now ? latestEnd + DAY : now;
  const n = cycles.length + 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-ink-faint">
          {projectId ? "This project's cycles, plus cross-project ones." : "Every cycle. Items join one from their drawer."}
        </p>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/5 hover:text-ink"
        >
          <Plus className="size-3" /> cycle
        </button>
      </div>
      {adding && (
        <CycleForm
          initial={{ name: `Cycle ${n}`, startsAt: dateInput(startDefault), endsAt: dateInput(startDefault + 13 * DAY) }}
          pending={pending}
          onCancel={() => setAdding(false)}
          onSubmit={(v) =>
            start(async () => {
              setError(null);
              try {
                await createCycleAction({ ...v, projectId: projectId ?? null });
                setAdding(false);
                router.refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            })
          }
        />
      )}
      {error && <p className="text-xs text-flare">{error}</p>}
      {sorted.length === 0 && !adding && (
        <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">
          No cycles yet. A cycle is a time-box (usually 1–2 weeks) you plan items into, so you can see whether you&apos;ll finish them.
        </p>
      )}
      {sorted.map((c) => (
        <CycleRow
          key={c.id}
          c={c}
          next={nextFor(c)}
          onSelect={() => onSelect(c.id)}
          projectName={!projectId && c.projectId ? (projectName.get(c.projectId) ?? null) : null}
        />
      ))}
      {sorted.length > 0 && (
        <p className="flex items-center gap-1.5 px-1 font-mono text-[10px] text-ink-faint">
          <Check className="size-3" /> burndown: solid = items still open each day, dashed = the ideal pace
        </p>
      )}
    </div>
  );
}
