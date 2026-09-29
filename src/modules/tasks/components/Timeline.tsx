"use client";

import { useMemo } from "react";
import { cn } from "@/core/ui/cn";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "../core";
import type { WorkFeature, WorkProject } from "../queries";
import { STATUS_META } from "../states";

const DAY = 86_400_000;
const DAY_PX = 22;
const LABEL_W = 220;

const dayStart = (t: number | Date | string) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

interface Row {
  item: WorkItem;
  start: number;
  end: number;
  /** Only one of start / due is set — drawn as a marker, not a span. */
  point: boolean;
}

/**
 * Items on a calendar: a bar from start → due, a diamond for items with only
 * one of the two. Grouped by project (all work) or feature (a project page),
 * with feature targets as milestones and a line for today. Undated open
 * items are counted, not drawn — the nudge is to give them dates.
 */
export function Timeline({
  items,
  features,
  projects,
  byFeature,
  onOpen,
}: {
  items: WorkItem[];
  features: WorkFeature[];
  projects: WorkProject[];
  byFeature: boolean;
  onOpen: (id: string) => void;
}) {
  const now = useNow();
  const today = dayStart(now);

  const { rows, undated } = useMemo(() => {
    const rows: Row[] = [];
    let undated = 0;
    for (const t of items) {
      const done = t.status === "done" || t.status === "cancelled";
      // Finished work older than two weeks is history, not plan.
      if (done && (!t.completedAt || today - +new Date(t.completedAt) > 14 * DAY)) continue;
      const s = t.startAt ? dayStart(t.startAt) : null;
      const d = t.dueAt ? dayStart(t.dueAt) : null;
      if (s == null && d == null) {
        if (!done) undated++;
        continue;
      }
      const start = s ?? d!;
      const end = Math.max(d ?? s!, start);
      rows.push({ item: t, start, end, point: s == null || d == null });
    }
    return { rows, undated };
  }, [items, today]);

  const milestones = features.filter((f) => f.targetAt && f.status !== "cancelled");

  // Window: a week back → the latest date shown (at least four weeks ahead), capped at ~6 months.
  const from = Math.min(today - 7 * DAY, ...rows.map((r) => r.start));
  const to = Math.max(today + 28 * DAY, ...rows.map((r) => r.end), ...milestones.map((f) => dayStart(f.targetAt!)));
  const start = Math.max(from, today - 60 * DAY);
  const end = Math.min(to, start + 180 * DAY);
  const days = Math.round((end - start) / DAY) + 1;
  const width = days * DAY_PX;
  const xOf = (t: number) => ((t - start) / DAY) * DAY_PX;

  const groups = useMemo(() => {
    const name = new Map<string, string>();
    if (byFeature) for (const f of features) name.set(`features:${f.id}`, f.name);
    else for (const p of projects) name.set(`projects:${p.id}`, p.key ? `${p.key} · ${p.name}` : p.name);
    const m = new Map<string, Row[]>();
    for (const r of [...rows].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const ref = (byFeature ? r.item.featureRef : r.item.projectRef) ?? "";
      m.set(ref, [...(m.get(ref) ?? []), r]);
    }
    return [...m.entries()]
      .map(([ref, rs]) => ({ ref, label: name.get(ref) ?? (byFeature ? "No feature" : "No project"), rows: rs }))
      .sort((a, b) => (a.ref ? 0 : 1) - (b.ref ? 0 : 1) || a.rows[0].start - b.rows[0].start);
  }, [rows, byFeature, features, projects]);

  const months: { x: number; label: string }[] = [];
  const weeks: number[] = [];
  for (let t = start; t <= end; t += DAY) {
    const d = new Date(t);
    if (d.getDate() === 1 || t === start) {
      // Year only where it changes (first column, January) — "Sep 26" would read as a day.
      const withYear = t === start || d.getMonth() === 0;
      months.push({ x: xOf(t), label: d.toLocaleDateString(undefined, withYear ? { month: "short", year: "numeric" } : { month: "long" }) });
    }
    if (d.getDay() === 1) weeks.push(xOf(t));
  }

  if (!rows.length && !milestones.length) {
    return (
      <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">
        Nothing is scheduled. Give items a start or due date (in the item, or <span className="font-mono">@fri</span> when you create one) to see them here.
        {undated > 0 && ` ${undated} open item${undated === 1 ? " has" : "s have"} no dates.`}
      </p>
    );
  }

  return (
    <div className="glass overflow-hidden rounded-xl">
      <div className="overflow-x-auto">
        <div className="relative" style={{ width: LABEL_W + width }}>
          {/* header */}
          <div className="sticky top-0 z-10 flex h-8 border-b border-white/6 bg-panel/80 backdrop-blur">
            <div className="sticky left-0 z-10 flex shrink-0 items-center bg-panel/95 px-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint" style={{ width: LABEL_W }}>
              {byFeature ? "feature / item" : "project / item"}
            </div>
            <div className="relative" style={{ width }}>
              {months.map((m) => (
                <span key={m.x} className="absolute top-1 font-mono text-[10px] text-ink-dim" style={{ left: m.x + 4 }}>
                  {m.label}
                </span>
              ))}
              {weeks.map((x) => (
                <span key={x} className="absolute bottom-0.5 font-mono text-[9px] tabular-nums text-ink-faint" style={{ left: x + 2 }}>
                  {new Date(start + (x / DAY_PX) * DAY).getDate()}
                </span>
              ))}
            </div>
          </div>

          {/* grid + today line */}
          <div className="pointer-events-none absolute bottom-0 top-8" style={{ left: LABEL_W, width }} aria-hidden>
            {weeks.map((x) => (
              <span key={x} className="absolute inset-y-0 w-px bg-white/[0.04]" style={{ left: x }} />
            ))}
            {today >= start && today <= end && (
              <span className="absolute inset-y-0 w-px bg-flare/60" style={{ left: xOf(today) + DAY_PX / 2 }} title="Today" />
            )}
          </div>

          {milestones.length > 0 && (
            <div className="relative flex h-7 items-center border-b border-white/5">
              <div className="sticky left-0 z-[1] shrink-0 bg-panel/95 px-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint" style={{ width: LABEL_W }}>
                feature targets
              </div>
              <div className="relative h-full" style={{ width }}>
                {milestones.map((f) => {
                  const t = dayStart(f.targetAt!);
                  if (t < start || t > end) return null;
                  return (
                    <span
                      key={f.id}
                      className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap"
                      style={{ left: xOf(t) + DAY_PX / 2 - 4 }}
                      title={`${f.name} — target ${new Date(t).toDateString()}`}
                    >
                      <span className={cn("size-2 rotate-45", f.status === "shipped" ? "bg-plasma" : "bg-solar")} />
                      <span className="font-mono text-[10px] text-ink-faint">{f.name}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.ref || "none"}>
              <div className="sticky left-0 flex h-7 items-center px-3 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim" style={{ width: LABEL_W }}>
                <span className="truncate">{g.label}</span>
              </div>
              {g.rows.map((r) => {
                const color = STATUS_META[r.item.status].color;
                const left = xOf(r.start);
                const w = (Math.round((r.end - r.start) / DAY) + 1) * DAY_PX;
                const late = !r.point && r.end < today && r.item.status !== "done" && r.item.status !== "cancelled";
                return (
                  <button
                    key={r.item.id}
                    type="button"
                    onClick={() => onOpen(r.item.id)}
                    className="group relative flex h-8 w-full items-center text-left transition hover:bg-white/[0.03]"
                  >
                    <span className="sticky left-0 z-[1] flex shrink-0 items-center gap-2 bg-panel/95 px-3" style={{ width: LABEL_W }}>
                      <span className="w-14 shrink-0 font-mono text-[10px] text-ink-faint">{r.item.identifier}</span>
                      <span dir="auto" className="truncate text-xs text-ink-dim group-hover:text-ink">{r.item.title}</span>
                    </span>
                    <span className="relative h-full" style={{ width }}>
                      {r.point ? (
                        <span
                          className="absolute top-1/2 size-2.5 -translate-y-1/2 rotate-45 rounded-[2px]"
                          style={{ left: left + DAY_PX / 2 - 5, background: color }}
                        />
                      ) : (
                        <span
                          className={cn("absolute top-1/2 h-3.5 -translate-y-1/2 rounded-full", late && "ring-1 ring-flare/60")}
                          style={{ left: left + 2, width: Math.max(8, w - 4), background: `color-mix(in oklab, ${color} 55%, transparent)` }}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {undated > 0 && (
        <p className="border-t border-white/5 px-3 py-2 font-mono text-[10px] text-ink-faint">
          + {undated} open item{undated === 1 ? "" : "s"} without dates (not shown)
        </p>
      )}
    </div>
  );
}
