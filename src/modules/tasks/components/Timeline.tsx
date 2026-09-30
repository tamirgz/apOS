"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useNow } from "@/core/ui/useNow";
import { updateFeature } from "@/modules/projects/features-actions";
import { updateTask } from "../actions";
import type { WorkItem } from "../core";
import type { WorkFeature, WorkProject } from "../queries";
import { STATUS_META, displayTitle, plainTitle } from "../states";
import { FEATURE_META, moduleStats } from "./ModulesView";
import { readPref, writePref } from "./prefs";

const DAY = 86_400_000;
const DAY_PX = 22;
const LABEL_W = 240;
const LABEL_MIN = 160;
const LABEL_MAX = 560;
/** Pointer travel before a press on a bar counts as a drag, not a click. */
const DRAG_SLOP = 3;

const dayStart = (t: number | Date | string) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
/** A day on the calendar → the Date we store (local noon, so no timezone flips it a day). */
// Re-anchored via dayStart so a day count crossing a DST change still lands on the intended day.
const noon = (day: number) => new Date(dayStart(day + 12 * 3_600_000) + 12 * 3_600_000);

type Mode = "move" | "start" | "end";
interface Span {
  start: number;
  end: number;
}

/** Where a span lands after dragging `delta` days by its body or one of its ends. */
function shift(s: Span, mode: Mode, days: number): Span {
  const d = days * DAY;
  if (mode === "start") return { start: Math.min(s.start + d, s.end), end: s.end };
  if (mode === "end") return { start: s.start, end: Math.max(s.end + d, s.start) };
  return { start: s.start + d, end: s.end + d };
}

/** One draggable bar: an item (start → due) or a module (start → target). */
interface Bar {
  key: string;
  span: Span;
  /** Only one date is set — a diamond that moves, never resizes. */
  point: boolean;
  color: string;
  /** Module progress (0–1), drawn as a fill inside the bar. */
  fill?: number;
  late?: boolean;
  module?: boolean;
  title: string;
  save: (s: Span) => Promise<unknown>;
  open: () => void;
}

interface Group {
  key: string;
  /** The group's own row — a module bar on a project page, else a plain heading. */
  head: { label: ReactNode; bar?: Bar; hint?: string; open?: () => void };
  rows: { item: WorkItem; bar: Bar }[];
  sortAt: number;
}

/**
 * The Gantt. Items are bars from start → due (a diamond when only one date is
 * set); modules are bars from start → target with their progress as a fill.
 * On a project page each module heads its own group; on all work the modules
 * get their own section and items group by project. Drag a bar to move it,
 * drag an end to change that date — the write goes straight to the item or
 * module. Undated open items are counted, not drawn.
 */
export function Timeline({
  items,
  features,
  projects,
  byFeature,
  onOpen,
  onOpenModule,
}: {
  items: WorkItem[];
  features: WorkFeature[];
  projects: WorkProject[];
  byFeature: boolean;
  onOpen: (id: string) => void;
  onOpenModule?: (id: string) => void;
}) {
  const router = useRouter();
  const now = useNow();
  const today = dayStart(now);
  const [, startSave] = useTransition();

  const [hideDone, setHideDone] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered toggle after hydration (localStorage is client-only)
  useEffect(() => setHideDone(readPref("work.timeline.hideDone", "0", ["0", "1"]) === "1"), []);
  const toggleHideDone = () => {
    setHideDone(!hideDone);
    writePref("work.timeline.hideDone", hideDone ? "0" : "1");
  };

  // Optimistic positions after a drop, cleared when the server sends fresh data.
  // The label column is resizable (drag its header edge); the width is remembered.
  const [labelW, setLabelW] = useState(LABEL_W);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem("work.timeline.labelW"));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered width after hydration (localStorage is client-only)
      if (v >= LABEL_MIN && v <= LABEL_MAX) setLabelW(v);
    } catch {
      /* private mode — default width */
    }
  }, []);
  const resizeLabels = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = labelW;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.min(LABEL_MAX, Math.max(LABEL_MIN, w0 + ev.clientX - x0));
      setLabelW(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      writePref("work.timeline.labelW", String(Math.round(w)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const [drafts, setDrafts] = useState<Record<string, Span>>({});
  const [seed, setSeed] = useState({ items, features });
  if (seed.items !== items || seed.features !== features) {
    setSeed({ items, features });
    setDrafts({});
  }
  const [drag, setDrag] = useState<{ key: string; mode: Mode; delta: number } | null>(null);

  const stats = useMemo(() => moduleStats(items), [items]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.key ?? p.name])), [projects]);

  const itemBar = (t: WorkItem): Bar | null => {
    const s = t.startAt ? dayStart(t.startAt) : null;
    const d = t.dueAt ? dayStart(t.dueAt) : null;
    if (s == null && d == null) return null;
    const point = s == null || d == null;
    const span = { start: s ?? d!, end: Math.max(d ?? s!, s ?? d!) };
    const closedItem = t.status === "done" || t.status === "cancelled";
    return {
      key: `t:${t.id}`,
      span,
      point,
      color: STATUS_META[t.status].color,
      late: !closedItem && span.end < today && (d != null || !point),
      title: `${t.identifier ?? ""} ${plainTitle(t.title)}`.trim(),
      save: (n) =>
        updateTask(t.id, point ? (s != null ? { startAt: noon(n.start) } : { dueAt: noon(n.start) }) : { startAt: noon(n.start), dueAt: noon(n.end) }),
      open: () => onOpen(t.id),
    };
  };

  const moduleBar = (f: WorkFeature): Bar | null => {
    const s = f.startAt ? dayStart(f.startAt) : null;
    const d = f.targetAt ? dayStart(f.targetAt) : null;
    if (s == null && d == null) return null;
    const point = s == null || d == null;
    const st = stats.get(f.id);
    const live = f.status !== "shipped" && f.status !== "cancelled";
    return {
      key: `f:${f.id}`,
      span: { start: s ?? d!, end: Math.max(d ?? s!, s ?? d!) },
      point,
      module: true,
      color: FEATURE_META[f.status].color,
      fill: st?.total ? st.closed / st.total : 0,
      late: live && d != null && d < today,
      title: f.name,
      save: (n) =>
        updateFeature(
          f.id,
          f.projectId,
          point ? (s != null ? { startAt: noon(n.start) } : { targetAt: noon(n.start) }) : { startAt: noon(n.start), targetAt: noon(n.end) },
        ),
      open: () => onOpenModule?.(f.id),
    };
  };

  // Items worth drawing: open ones with a date; finished ones only while recent (and not hidden).
  let undated = 0;
  const dated: { item: WorkItem; bar: Bar }[] = [];
  for (const t of items) {
    const done = t.status === "done" || t.status === "cancelled";
    if (done && (hideDone || !t.completedAt || today - +new Date(t.completedAt) > 14 * DAY)) continue;
    const bar = itemBar(t);
    if (!bar) {
      if (!done) undated++;
      continue;
    }
    dated.push({ item: t, bar });
  }
  dated.sort((a, b) => a.bar.span.start - b.bar.span.start || a.bar.span.end - b.bar.span.end);
  const shownFeatures = features.filter((f) => f.status !== "cancelled" && !(hideDone && f.status === "shipped"));

  const groups: Group[] = [];
  let moduleRows: { f: WorkFeature; bar: Bar }[] = [];
  if (byFeature) {
    const byRef = new Map<string, { item: WorkItem; bar: Bar }[]>();
    for (const r of dated) {
      const ref = r.item.featureRef ?? "";
      byRef.set(ref, [...(byRef.get(ref) ?? []), r]);
    }
    for (const f of shownFeatures) {
      const rows = byRef.get(`features:${f.id}`) ?? [];
      const bar = moduleBar(f) ?? undefined;
      if (!rows.length && !bar) continue;
      groups.push({
        key: f.id,
        head: { label: f.name, bar, hint: bar ? undefined : "no dates — set them on the module", open: () => onOpenModule?.(f.id) },
        rows,
        sortAt: Math.min(bar?.span.start ?? Infinity, rows[0]?.bar.span.start ?? Infinity),
      });
    }
    const loose = [...byRef.entries()].filter(([ref]) => !ref || !shownFeatures.some((f) => `features:${f.id}` === ref)).flatMap(([, rs]) => rs);
    if (loose.length) groups.push({ key: "none", head: { label: "No module" }, rows: loose, sortAt: Infinity });
    groups.sort((a, b) => a.sortAt - b.sortAt);
  } else {
    moduleRows = shownFeatures
      .map((f) => ({ f, bar: moduleBar(f) }))
      .filter((r): r is { f: WorkFeature; bar: Bar } => !!r.bar)
      .sort((a, b) => a.bar.span.start - b.bar.span.start);
    const name = new Map(projects.map((p) => [`projects:${p.id}`, p.key ? `${p.key} · ${p.name}` : p.name]));
    const byRef = new Map<string, { item: WorkItem; bar: Bar }[]>();
    for (const r of dated) {
      const ref = r.item.projectRef ?? "";
      byRef.set(ref, [...(byRef.get(ref) ?? []), r]);
    }
    for (const [ref, rows] of byRef)
      groups.push({ key: ref || "none", head: { label: name.get(ref) ?? "No project" }, rows, sortAt: ref ? rows[0].bar.span.start : Infinity });
    groups.sort((a, b) => a.sortAt - b.sortAt);
  }

  const allBars = [...dated.map((r) => r.bar), ...moduleRows.map((r) => r.bar), ...groups.flatMap((g) => (g.head.bar ? [g.head.bar] : []))];

  // Window: a week back → the latest date shown (at least four weeks ahead), capped at ~6 months.
  const from = Math.min(today - 7 * DAY, ...allBars.map((b) => b.span.start));
  const to = Math.max(today + 28 * DAY, ...allBars.map((b) => b.span.end));
  const start = Math.max(from, today - 60 * DAY);
  const end = Math.min(to + 7 * DAY, start + 180 * DAY);
  const days = Math.round((end - start) / DAY) + 1;
  const width = days * DAY_PX;
  const xOf = (t: number) => ((t - start) / DAY) * DAY_PX;

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

  /** Press on a bar: a click opens it, a drag moves it (or one end) by whole days. */
  const begin = (e: React.PointerEvent, bar: Bar, mode: Mode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let delta = 0;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > DRAG_SLOP) moved = true;
      const d = Math.round((ev.clientX - x0) / DAY_PX);
      if (d !== delta || moved) {
        delta = d;
        setDrag({ key: bar.key, mode, delta: d });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (!moved) return bar.open();
      if (!delta) return;
      const next = shift(current(bar), mode, delta);
      setDrafts((p) => ({ ...p, [bar.key]: next }));
      startSave(async () => {
        await bar.save(next);
        router.refresh();
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const current = (bar: Bar) => drafts[bar.key] ?? bar.span;
  const shown = (bar: Bar) => (drag?.key === bar.key ? shift(current(bar), bar.point ? "move" : drag.mode, drag.delta) : current(bar));

  if (!allBars.length) {
    return (
      <div className="flex flex-col gap-2">
        <Toolbar hideDone={hideDone} onToggle={toggleHideDone} />
        <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">
          Nothing is scheduled. Give items a start or due date (in the item, or <span className="font-mono">@fri</span> when you create one) — or
          a module its start and target — to see them here.
          {undated > 0 && ` ${undated} open item${undated === 1 ? " has" : "s have"} no dates.`}
        </p>
      </div>
    );
  }

  const barEl = (bar: Bar) => {
    const s = shown(bar);
    const left = xOf(s.start);
    const w = (Math.round((s.end - s.start) / DAY) + 1) * DAY_PX;
    const dragging = drag?.key === bar.key;
    const label = dragging
      ? bar.point
        ? shortDay(s.start)
        : `${shortDay(s.start)} → ${shortDay(s.end)}`
      : null;
    if (bar.point) {
      return (
        <span
          onPointerDown={(e) => begin(e, bar, "move")}
          title={`${plainTitle(bar.title)} — drag to move`}
          className="absolute top-1/2 flex size-4 -translate-y-1/2 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
          style={{ left: left + DAY_PX / 2 - 8 }}
        >
          <span
            className={cn(
              "rotate-45 rounded-[2px]",
              bar.module ? "size-3 ring-1 ring-white/20" : "size-2.5",
              bar.late && "ring-1 ring-flare/70",
              dragging && "ring-1 ring-ion/70",
            )}
            style={{ background: bar.color }}
          />
          {label && <DragLabel text={label} />}
        </span>
      );
    }
    return (
      <span
        onPointerDown={(e) => begin(e, bar, "move")}
        title={`${plainTitle(bar.title)} — drag to move, drag an end to change that date`}
        className={cn(
          "group/bar absolute top-1/2 -translate-y-1/2 cursor-grab touch-none overflow-visible rounded-full active:cursor-grabbing",
          bar.module ? "h-4 border" : "h-3.5",
          bar.late && "ring-1 ring-flare/60",
          dragging && "ring-1 ring-ion/70",
        )}
        style={{
          left: left + 2,
          width: Math.max(8, w - 4),
          ...(bar.module
            ? { borderColor: `color-mix(in oklab, ${bar.color} 60%, transparent)`, background: `color-mix(in oklab, ${bar.color} 14%, transparent)` }
            : { background: `color-mix(in oklab, ${bar.color} 55%, transparent)` }),
        }}
      >
        {bar.module && bar.fill != null && (
          <span className="absolute inset-y-0 left-0 rounded-full bg-plasma/45" style={{ width: `${Math.round(bar.fill * 100)}%` }} />
        )}
        <span onPointerDown={(e) => begin(e, bar, "start")} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-full group-hover/bar:bg-white/25" />
        <span onPointerDown={(e) => begin(e, bar, "end")} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-full group-hover/bar:bg-white/25" />
        {label && <DragLabel text={label} />}
      </span>
    );
  };

  const row = (key: string, labelEl: ReactNode, bar: Bar | undefined, opts: { head?: boolean; hint?: string } = {}) => (
    <div key={key} className={cn("group relative flex items-center transition hover:bg-white/[0.03]", opts.head ? "h-9 border-t border-white/5" : "h-8")}>
      <span className="sticky left-0 z-[1] flex h-full shrink-0 items-center bg-panel/95 px-3" style={{ width: labelW }}>
        {labelEl}
      </span>
      <span className="relative h-full" style={{ width }}>
        {bar ? barEl(bar) : opts.hint && <span className="absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-ink-faint/70">{opts.hint}</span>}
      </span>
    </div>
  );

  const moduleLabel = (name: ReactNode, open?: () => void, pct?: number) => (
    <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!open}>
      <Layers className="size-3.5 shrink-0 text-ion" />
      <span dir="auto" className="truncate text-xs font-medium text-ink-dim hover:text-ink">
        {name}
      </span>
      {pct != null && <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{pct}%</span>}
    </button>
  );

  const itemLabel = (t: WorkItem) => (
    <button type="button" onClick={() => onOpen(t.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
      <span className="w-16 shrink-0 font-mono text-[10px] text-ink-faint">{t.identifier}</span>
      <span dir="auto" className={cn("truncate text-xs text-ink-dim group-hover:text-ink", (t.status === "done" || t.status === "cancelled") && "line-through opacity-60")}>
        {displayTitle(t)}
      </span>
    </button>
  );

  const pctOf = (id: string) => {
    const s = stats.get(id);
    return s?.total ? Math.round((s.closed / s.total) * 100) : undefined;
  };

  return (
    <div className="flex flex-col gap-2">
      <Toolbar hideDone={hideDone} onToggle={toggleHideDone} />
      <div className={cn("glass overflow-hidden rounded-xl", drag && "select-none")}>
        <div className="overflow-x-auto">
          <div className="relative" style={{ width: labelW + width }}>
            {/* header */}
            <div className="sticky top-0 z-10 flex h-8 border-b border-white/6 bg-panel/80 backdrop-blur">
              <div className="sticky left-0 z-10 flex shrink-0 items-center bg-panel/95 px-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint" style={{ width: labelW }}>
                {byFeature ? "module / item" : "project / item"}
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the label column"
                  title="Drag to resize"
                  onPointerDown={resizeLabels}
                  className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize border-r border-white/8 transition hover:border-ion/60 hover:bg-ion/10"
                />
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
            <div className="pointer-events-none absolute bottom-0 top-8" style={{ left: labelW, width }} aria-hidden>
              {weeks.map((x) => (
                <span key={x} className="absolute inset-y-0 w-px bg-white/[0.04]" style={{ left: x }} />
              ))}
              {today >= start && today <= end && (
                <span className="absolute inset-y-0 w-px bg-flare/60" style={{ left: xOf(today) + DAY_PX / 2 }} title="Today" />
              )}
            </div>

            {moduleRows.length > 0 && (
              <div className="border-b border-white/6 pb-1">
                <div className="sticky left-0 flex h-7 items-center px-3 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim" style={{ width: labelW }}>
                  Modules
                </div>
                {moduleRows.map(({ f, bar }) =>
                  row(
                    `m:${f.id}`,
                    moduleLabel(
                      <>
                        <span className="text-ink-faint">{projectName.get(f.projectId)} · </span>
                        {f.name}
                      </>,
                      onOpenModule && (() => onOpenModule(f.id)),
                      pctOf(f.id),
                    ),
                    bar,
                  ),
                )}
              </div>
            )}

            {groups.map((g) => (
              <div key={g.key}>
                {byFeature ? (
                  row(`g:${g.key}`, moduleLabel(g.head.label, g.head.open, g.key !== "none" ? pctOf(g.key) : undefined), g.head.bar, { head: true, hint: g.head.hint })
                ) : (
                  <div className="sticky left-0 flex h-7 items-center px-3 text-xs font-medium text-ink-dim" style={{ width: labelW }}>
                    <span className="truncate">{g.head.label}</span>
                  </div>
                )}
                {g.rows.map((r) => row(r.bar.key, itemLabel(r.item), r.bar))}
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
    </div>
  );
}

const shortDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function DragLabel({ text }: { text: string }) {
  return (
    <span className="pointer-events-none absolute -top-5 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-void/90 px-1.5 py-0.5 font-mono text-[10px] text-ion">
      {text}
    </span>
  );
}

function Toolbar({ hideDone, onToggle }: { hideDone: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3 font-mono text-[10px] text-ink-faint">
      <label className="flex cursor-pointer items-center gap-1.5 uppercase tracking-widest">
        <input type="checkbox" checked={hideDone} onChange={onToggle} className="accent-[var(--color-ion)]" />
        hide done
      </label>
      <span className="ml-auto">drag a bar to move it · drag an end to change that date · click to open</span>
    </div>
  );
}
