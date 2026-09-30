"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Crosshair, Diamond } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { useNow } from "@/core/ui/useNow";
import { updateFeature } from "@/modules/projects/features-actions";
import { updateTask } from "../actions";
import type { WorkItem } from "../core";
import type { WorkFeature, WorkProject } from "../queries";
import { STATUS_META, displayTitle, plainTitle } from "../states";
import { modulePct } from "../stats";
import { FEATURE_META, moduleStats } from "./ModulesView";
import { readPref, writePref } from "./prefs";
import { StateGlyph, isClosed } from "./work-ui";

const DAY = 86_400_000;
type Zoom = "week" | "month" | "quarter";
/** Pixels per day and the widest window each zoom draws. */
const ZOOMS: { id: Zoom; label: string; px: number; span: number; ahead: number }[] = [
  { id: "week", label: "Week", px: 40, span: 120, ahead: 28 },
  { id: "month", label: "Month", px: 22, span: 180, ahead: 56 },
  { id: "quarter", label: "Quarter", px: 8, span: 400, ahead: 120 },
];
const COLLAPSED_KEY = "work.timeline.collapsed";
const LABEL_W = 300;
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
  /** A module without its own dates, drawn over its items' span. */
  derived?: boolean;
  /** Text inside the bar (item id, or a module's % done). */
  text?: string;
  /** Quiet text past the bar's end — a module's target date. */
  after?: string;
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
  deps = [],
  selectedId = null,
  onOpen,
  onOpenModule,
}: {
  items: WorkItem[];
  features: WorkFeature[];
  projects: WorkProject[];
  byFeature: boolean;
  /** Open "blocks" relations — drawn as arrows from the blocker's end to the blocked item's start. */
  deps?: { from: string; to: string }[];
  selectedId?: string | null;
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

  const [zoom, setZoom] = useState<Zoom>("month");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered zoom after hydration (localStorage is client-only)
  useEffect(() => setZoom(readPref<Zoom>("work.timeline.zoom", "month", ["week", "month", "quarter"])), []);
  const pickZoom = (z: Zoom) => {
    setZoom(z);
    writePref("work.timeline.zoom", z);
  };
  const zoomMeta = ZOOMS.find((z) => z.id === zoom)!;
  const DAY_PX = zoomMeta.px;

  // Collapsed groups (module / project / the unscheduled tray), remembered per browser.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore remembered groups after hydration (localStorage is client-only)
      if (Array.isArray(v)) setCollapsed(new Set(v.filter((x) => typeof x === "string")));
    } catch {
      /* private mode or bad JSON — everything open */
    }
  }, []);
  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    writePref(COLLAPSED_KEY, JSON.stringify([...next].slice(-200)));
  };
  const [allUnscheduled, setAllUnscheduled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<Zoom | null>(null);

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
      text: t.estimate ? `${t.identifier ?? ""} · ${t.estimate}p` : (t.identifier ?? ""),
      late: !closedItem && span.end < today && (d != null || !point),
      title: `${t.identifier ?? ""} ${plainTitle(t.title)}`.trim(),
      save: (n) =>
        updateTask(t.id, point ? (s != null ? { startAt: noon(n.start) } : { dueAt: noon(n.start) }) : { startAt: noon(n.start), dueAt: noon(n.end) }),
      open: () => onOpen(t.id),
    };
  };

  // A module's span: its own start → target, or — with neither set — the span of its dated items.
  const itemSpan = useMemo(() => {
    const m = new Map<string, Span>();
    for (const t of items) {
      if (!t.featureRef?.startsWith("features:")) continue;
      const ds = [t.startAt, t.dueAt].filter(Boolean).map((x) => dayStart(x!));
      if (!ds.length) continue;
      const id = t.featureRef.slice(9);
      const cur = m.get(id);
      m.set(id, { start: Math.min(cur?.start ?? Infinity, ...ds), end: Math.max(cur?.end ?? -Infinity, ...ds) });
    }
    return m;
  }, [items]);

  const moduleBar = (f: WorkFeature): Bar | null => {
    let s = f.startAt ? dayStart(f.startAt) : null;
    let d = f.targetAt ? dayStart(f.targetAt) : null;
    // A missing end comes from the module's items: a target alone starts at its earliest item,
    // a start alone ends at its latest one — so a milestone reads as a range, not a lone diamond.
    const span = itemSpan.get(f.id);
    const own = (s == null ? 0 : 1) + (d == null ? 0 : 1);
    if (span) {
      if (s == null && span.start < (d ?? Infinity)) s = span.start;
      if (d == null && span.end > (s ?? -Infinity)) d = span.end;
    }
    if (s == null && d == null) return null;
    const point = s == null || d == null;
    const derived = !point && own < 2;
    const st = stats.get(f.id);
    const live = f.status !== "shipped" && f.status !== "cancelled";
    return {
      key: `f:${f.id}`,
      span: { start: s ?? d!, end: Math.max(d ?? s!, s ?? d!) },
      point,
      module: true,
      derived,
      text: st?.total ? `${modulePct(st)}%` : undefined,
      after: f.targetAt ? shortDay(dayStart(f.targetAt)) : undefined,
      color: FEATURE_META[f.status].color,
      fill: st?.total ? modulePct(st) / 100 : 0,
      late: live && !!f.targetAt && dayStart(f.targetAt) < today,
      title: derived ? `${f.name} (span of its items — drag to set the module's dates)` : f.name,
      save: (n) =>
        updateFeature(
          f.id,
          f.projectId,
          point
            ? s != null
              ? { startAt: noon(n.start) }
              : { targetAt: noon(n.start) }
            : { startAt: noon(n.start), targetAt: noon(n.end) },
        ),
      open: () => onOpenModule?.(f.id),
    };
  };

  // Items worth drawing: open ones with a date; finished ones only while recent (and not hidden).
  const undated: WorkItem[] = [];
  const dated: { item: WorkItem; bar: Bar }[] = [];
  for (const t of items) {
    const done = t.status === "done" || t.status === "cancelled";
    if (done && (hideDone || !t.completedAt || today - +new Date(t.completedAt) > 14 * DAY)) continue;
    const bar = itemBar(t);
    if (!bar) {
      if (!done) undated.push(t);
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
    const name = new Map(projects.map((p) => [`projects:${p.id}`, p.key && p.key !== p.name ? `${p.key} · ${p.name}` : p.name]));
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

  // Window: a week back → the latest date shown (at least the zoom's look-ahead, so the grid fills the width), capped per zoom.
  const from = Math.min(today - 7 * DAY, ...allBars.map((b) => b.span.start));
  const to = Math.max(today + zoomMeta.ahead * DAY, ...allBars.map((b) => b.span.end));
  const start = Math.max(from, today - 60 * DAY);
  const end = Math.min(to + 7 * DAY, start + zoomMeta.span * DAY);
  const days = Math.round((end - start) / DAY) + 1;
  const width = days * DAY_PX;
  const xOf = (t: number) => ((t - start) / DAY) * DAY_PX;

  const months: { x: number; label: string }[] = [];
  const weeks: number[] = [];
  const weekends: number[] = [];
  const dayTicks: { x: number; label: string; weekend: boolean }[] = [];
  for (let t = start; t <= end; t += DAY) {
    const d = new Date(t);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (zoom === "week") {
      if (weekend) weekends.push(xOf(t));
      dayTicks.push({ x: xOf(t), label: `${"SMTWTFS"[d.getDay()]} ${d.getDate()}`, weekend });
    }
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
        const r = await act(() => bar.save(next), { failed: bar.module ? "Couldn't reschedule the module" : "Couldn't reschedule the item" });
        if (!r.ok)
          setDrafts((p) => {
            const rest = { ...p };
            delete rest[bar.key];
            return rest;
          });
        router.refresh();
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const todayX = xOf(today);
  const scrollToToday = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, todayX - (el.clientWidth - labelW) * 0.25), behavior: smooth ? "smooth" : "auto" });
  };
  // Open on today (and again on each zoom change), not on the window's first week.
  useEffect(() => {
    if (scrolledFor.current === zoom || !scrollRef.current) return;
    scrolledFor.current = zoom;
    const el = scrollRef.current;
    el.scrollTo({ left: Math.max(0, todayX - (el.clientWidth - labelW) * 0.25) });
  }, [zoom, todayX, labelW]);

  const current = (bar: Bar) => drafts[bar.key] ?? bar.span;
  const shown = (bar: Bar) => (drag?.key === bar.key ? shift(current(bar), bar.point ? "move" : drag.mode, drag.delta) : current(bar));

  const tray = undated.length > 0 && (
    <Unscheduled
      items={undated}
      open={!collapsed.has("unscheduled")}
      all={allUnscheduled}
      onToggle={() => toggleGroup("unscheduled")}
      onShowAll={() => setAllUnscheduled(true)}
      projectName={byFeature ? undefined : (ref) => (ref?.startsWith("projects:") ? projectName.get(ref.slice(9)) : undefined)}
      selectedId={selectedId}
      onOpen={onOpen}
    />
  );
  const toolbar = (
    <Toolbar zoom={zoom} onZoom={pickZoom} hideDone={hideDone} onToggle={toggleHideDone} onToday={allBars.length ? () => scrollToToday() : undefined} />
  );

  if (!allBars.length) {
    return (
      <div className="flex flex-col gap-3">
        {toolbar}
        <div className="glass overflow-hidden rounded-2xl">
          <p className="px-5 py-8 text-center text-sm text-ink-faint">
            Nothing is scheduled. Give items a start or due date (in the item, or <span className="font-mono">@fri</span> when you create one) —
            or a module its start and target — to see them here.
          </p>
          {tray}
        </div>
      </div>
    );
  }

  const ROW_H = 34;
  const barEl = (bar: Bar, selected = false) => {
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
              bar.module ? "size-3 ring-1 ring-ink/25" : "size-2.5",
              bar.late && "ring-1 ring-flare/70",
              (dragging || selected) && "ring-2 ring-ion/80",
            )}
            style={{ background: bar.color }}
          />
          {bar.module && !label && (bar.text || bar.after) && (
            <span className={cn("pointer-events-none absolute left-5 whitespace-nowrap font-mono text-[10.5px]", bar.late ? "text-flare" : "text-ink-faint")}>
              {[bar.text, bar.after].filter(Boolean).join(" · ")}
            </span>
          )}
          {label && <DragLabel text={label} />}
        </span>
      );
    }
    const width = Math.max(8, w - 4);
    // The label sits inside when it fits (≈6.5px a character + padding), else just past the bar's end.
    const inside = !!bar.text && width >= bar.text.length * (bar.module ? 6.6 : 6.4) + 14;
    return (
      <span
        onPointerDown={(e) => begin(e, bar, "move")}
        title={`${plainTitle(bar.title)} — drag to move, drag an end to change that date`}
        className={cn(
          "group/bar absolute top-1/2 -translate-y-1/2 cursor-grab touch-none overflow-visible rounded-md active:cursor-grabbing",
          bar.module ? "h-5 border" : "h-4",
          bar.derived && "border-dashed",
          bar.late && "ring-1 ring-flare/70",
          (dragging || selected) && "ring-2 ring-ion/80",
        )}
        style={{
          left: left + 2,
          width,
          ...(bar.module
            ? { borderColor: bar.color, background: "transparent" }
            : { background: `color-mix(in oklab, ${bar.color} 88%, transparent)` }),
        }}
      >
        {bar.module && bar.fill != null && (
          <span className="absolute inset-y-0 left-0 rounded-[5px] opacity-30" style={{ width: `${Math.round(bar.fill * 100)}%`, background: bar.color }} />
        )}
        {!label && (bar.module ? [inside ? null : bar.text, bar.after] : [inside ? null : bar.text]).some(Boolean) && (
          <span
            className={cn(
              "pointer-events-none absolute left-full top-1/2 ml-1.5 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px]",
              bar.module ? (bar.late ? "text-flare" : "text-ink-faint") : "text-ink-dim",
            )}
          >
            {(bar.module ? [inside ? null : bar.text, bar.after] : [bar.text]).filter(Boolean).join(" · ")}
          </span>
        )}
        {inside && (
          <span
            className={cn(
              "pointer-events-none absolute inset-0 overflow-hidden whitespace-nowrap px-1.5 leading-[inherit]",
              bar.module ? "text-[11px] font-medium leading-[18px] text-ink" : "font-mono text-[10.5px] font-semibold leading-4 text-void",
            )}
          >
            {bar.text}
          </span>
        )}
        <span onPointerDown={(e) => begin(e, bar, "start")} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md group-hover/bar:bg-ink/25" />
        <span onPointerDown={(e) => begin(e, bar, "end")} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md group-hover/bar:bg-ink/25" />
        {label && <DragLabel text={label} />}
      </span>
    );
  };

  // Dependency arrows: blocker's end → blocked item's start, drawn in the blocked row.
  const barOf = new Map(dated.map((r) => [r.item.id, r.bar]));
  const incoming = new Map<string, Bar[]>();
  for (const d of deps) {
    const from = barOf.get(d.from);
    if (!from || !barOf.has(d.to)) continue;
    incoming.set(d.to, [...(incoming.get(d.to) ?? []), from]);
  }
  const depEls = (id: string) =>
    (incoming.get(id) ?? []).map((from) => {
      const to = barOf.get(id)!;
      const x1 = xOf(shown(from).end) + DAY_PX - 2;
      const x2 = xOf(shown(to).start) + 2;
      // Overlapping spans (the blocked item starts before its blocker ends): a short arrow into the start.
      const [l, w] = x2 - x1 >= 8 ? [x1, x2 - x1] : [x2 - 14, 12];
      return <span key={from.key} className="wk-dep" style={{ left: l, width: w }} title="blocked by an open item" aria-hidden />;
    });

  const row = (key: string, labelEl: ReactNode, bar: Bar | undefined, opts: { head?: boolean; hint?: string; id?: string } = {}) => {
    const selected = !!opts.id && opts.id === selectedId;
    return (
      <div
        key={key}
        className={cn("group relative flex items-center border-b wk-line transition hover:bg-ink/[0.03]", selected && "!bg-ion/8")}
        style={{ height: opts.head ? ROW_H + 2 : ROW_H }}
      >
        <span
          className={cn("sticky left-0 z-[2] flex h-full shrink-0 items-center border-r wk-line bg-panel px-3", selected && "shadow-[inset_2px_0_0_var(--color-ion)]")}
          style={{ width: labelW }}
        >
          {labelEl}
        </span>
        <span className="relative h-full" style={{ width }}>
          {opts.id && depEls(opts.id)}
          {bar ? barEl(bar, selected) : opts.hint && <span className="absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[10.5px] text-ink-faint">{opts.hint}</span>}
        </span>
      </div>
    );
  };

  const chevron = (key: string, count: number) => (
    <button
      type="button"
      onClick={() => toggleGroup(key)}
      aria-expanded={!collapsed.has(key)}
      aria-label={collapsed.has(key) ? `Show ${count} item${count === 1 ? "" : "s"}` : "Collapse"}
      title={collapsed.has(key) ? `Show ${count} item${count === 1 ? "" : "s"}` : "Collapse"}
      className="-ml-1.5 shrink-0 rounded p-0.5 text-ink-faint transition hover:bg-ink/6 hover:text-ink"
    >
      <ChevronRight className={cn("size-3.5 transition-transform", !collapsed.has(key) && "rotate-90")} />
    </button>
  );

  const moduleLabel = (name: ReactNode, open?: () => void, pct?: number, status?: WorkFeature["status"]) => (
    <button type="button" onClick={open} className="group/ml flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!open}>
      <Diamond
        className="size-3.5 shrink-0"
        style={{ color: status ? FEATURE_META[status].color : "var(--color-ink-faint)" }}
        fill="currentColor"
        fillOpacity={status === "shipped" ? 0.9 : 0.25}
      />
      <span dir="auto" className="truncate font-display text-[13.5px] font-semibold text-ink transition group-hover/ml:text-plasma">
        {name}
      </span>
      {pct != null && <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">{pct}%</span>}
    </button>
  );

  const itemLabel = (t: WorkItem) => (
    <button type="button" onClick={() => onOpen(t.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
      <StateGlyph s={t.status} />
      <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">{t.identifier}</span>
      <span dir="auto" className={cn("truncate text-[12.5px] text-ink-dim group-hover:text-ink", isClosed(t.status) && "line-through opacity-60")}>
        {displayTitle(t)}
      </span>
    </button>
  );

  const pctOf = (id: string) => {
    const s = stats.get(id);
    return s?.total ? modulePct(s) : undefined;
  };
  const featureStatus = new Map(features.map((f) => [f.id, f.status]));

  return (
    <div className="flex flex-col gap-3">
      {toolbar}
      <div className={cn("glass overflow-hidden rounded-2xl", drag && "select-none")}>
        <div ref={scrollRef} className="overflow-x-auto">
          <div className="relative" style={{ width: labelW + width }}>
            {/* header */}
            <div className="sticky top-0 z-10 flex h-[46px] border-b wk-line-strong bg-panel">
              <div
                className="sticky left-0 z-10 flex shrink-0 items-end border-r wk-line bg-panel px-3 pb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint"
                style={{ width: labelW }}
              >
                {byFeature ? "Module / item" : "Project / item"}
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the label column"
                  title="Drag to resize"
                  onPointerDown={resizeLabels}
                  className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize transition hover:bg-ion/15"
                />
              </div>
              <div className="relative" style={{ width }}>
                {months.map((m, i) => (
                  <span
                    key={m.x}
                    className="absolute top-0 h-[26px] border-l wk-line-strong px-2 pt-1.5 font-mono text-[11.5px] text-ink-dim"
                    style={{ left: m.x, width: (months[i + 1]?.x ?? width) - m.x }}
                  >
                    {m.label}
                  </span>
                ))}
                {zoom === "week"
                  ? dayTicks.map((d) => (
                      <span
                        key={d.x}
                        className={cn(
                          "absolute bottom-1 text-center font-mono text-[10px] tabular-nums",
                          d.x === todayX ? "font-semibold text-solar" : d.weekend ? "text-ink-faint/60" : "text-ink-faint",
                        )}
                        style={{ left: d.x, width: DAY_PX }}
                      >
                        {d.label}
                      </span>
                    ))
                  : weeks.map((x) => (
                      <span key={x} className="absolute bottom-1 font-mono text-[10px] tabular-nums text-ink-faint" style={{ left: x + 3 }}>
                        {new Date(start + (x / DAY_PX) * DAY).getDate()}
                      </span>
                    ))}
              </div>
            </div>

            {/* grid + today line */}
            <div className="pointer-events-none absolute bottom-0 top-[46px] z-[1]" style={{ left: labelW, width }} aria-hidden>
              {weekends.map((x) => (
                <span key={`w${x}`} className="absolute inset-y-0 bg-ink/[0.025]" style={{ left: x, width: DAY_PX }} />
              ))}
              {weeks.map((x) => (
                <span key={x} className="absolute inset-y-0 w-px bg-ion/[0.05]" style={{ left: x }} />
              ))}
              {months.slice(1).map((m) => (
                <span key={`m${m.x}`} className="absolute inset-y-0 w-px bg-ion/[0.14]" style={{ left: m.x }} />
              ))}
              {today >= start && today <= end && <span className="wk-today" style={{ left: todayX + DAY_PX / 2 - 1 }} title="Today" />}
            </div>

            {moduleRows.length > 0 && (
              <div className="border-b wk-line-strong">
                <div className="sticky left-0 flex h-8 items-center gap-1.5 px-3" style={{ width: labelW }}>
                  {chevron("modules", moduleRows.length)}
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
                    Modules <span className="tabular-nums">{moduleRows.length}</span>
                  </span>
                </div>
                {!collapsed.has("modules") &&
                  moduleRows.map(({ f, bar }) =>
                    row(
                      `m:${f.id}`,
                      moduleLabel(
                        <>
                          {projectName.get(f.projectId) && (
                            <span className="font-mono text-[11px] font-normal text-ink-faint">{projectName.get(f.projectId)} · </span>
                          )}
                          {f.name}
                        </>,
                        onOpenModule && (() => onOpenModule(f.id)),
                        pctOf(f.id),
                        f.status,
                      ),
                      bar,
                      { head: true },
                    ),
                  )}
              </div>
            )}

            {groups.map((g) => {
              const shut = collapsed.has(g.key) && g.rows.length > 0;
              return (
                <div key={g.key}>
                  {byFeature ? (
                    row(
                      `g:${g.key}`,
                      <>
                        {g.rows.length > 0 && chevron(g.key, g.rows.length)}
                        {moduleLabel(g.head.label, g.head.open, g.key !== "none" ? pctOf(g.key) : undefined, featureStatus.get(g.key))}
                        {shut && <span className="ml-2 shrink-0 font-mono text-[11px] text-ink-faint">{g.rows.length}</span>}
                      </>,
                      g.head.bar,
                      { head: true, hint: g.head.hint },
                    )
                  ) : (
                    <div className="sticky left-0 flex h-8 items-center gap-1.5 px-3" style={{ width: labelW }}>
                      {chevron(g.key, g.rows.length)}
                      <span className="truncate font-display text-[13px] font-semibold text-ink">{g.head.label}</span>
                      <span className="font-mono text-[11px] tabular-nums text-ink-faint">{g.rows.length}</span>
                    </div>
                  )}
                  {!shut && g.rows.map((r) => row(r.bar.key, itemLabel(r.item), r.bar, { id: r.item.id }))}
                </div>
              );
            })}
          </div>
        </div>
        {tray}
      </div>
    </div>
  );
}

const shortDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function DragLabel({ text }: { text: string }) {
  return (
    <span className="pointer-events-none absolute -top-5 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-void/90 px-1.5 py-0.5 font-mono text-[10.5px] text-ion">
      {text}
    </span>
  );
}

const LEGEND_STATES = ["todo", "doing", "review", "done"] as const;

function Toolbar({
  zoom,
  onZoom,
  hideDone,
  onToggle,
  onToday,
}: {
  zoom: Zoom;
  onZoom: (z: Zoom) => void;
  hideDone: boolean;
  onToggle: () => void;
  onToday?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="wk-tabs" role="radiogroup" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z.id} type="button" role="radio" aria-checked={zoom === z.id} onClick={() => onZoom(z.id)}>
              {z.label}
            </button>
          ))}
        </div>
        {onToday && (
          <button type="button" onClick={onToday} className="wk-btn !py-1 text-xs" title="Scroll to today">
            <Crosshair className="size-3.5 text-solar" /> Today
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={hideDone}
          className={cn("wk-chip transition hover:text-ink", hideDone && "!border-plasma/45 text-ink")}
          title={hideDone ? "Showing open work only" : "Recently finished items and shipped modules are shown"}
        >
          <i className="dot" style={{ color: hideDone ? "var(--color-plasma)" : "var(--color-ink-faint)" }} />
          Hide done
        </button>
        <span className="ml-auto text-[11.5px] text-ink-faint">Drag a bar to move it · drag an end to change that date · click to open</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
        {LEGEND_STATES.map((st) => (
          <span key={st} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-3.5 rounded-[3px]" style={{ background: STATUS_META[st].color }} />
            {STATUS_META[st].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-4 rounded-[3px] border border-ink-dim" /> module
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-4 rounded-[3px] border border-dashed border-ink-dim" /> span of its items
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2 w-3.5 rounded-[3px] bg-ink/20 ring-1 ring-flare/70" /> late
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="relative inline-block h-0.5 w-4 bg-flare/70" /> blocked by
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-3 w-0.5 bg-solar" /> today
        </span>
      </div>
    </div>
  );
}

const UNSCHEDULED_CAP = 8;

/** Open items with no start or due date: listed, not drawn, so they aren't forgotten. */
function Unscheduled({
  items,
  open,
  all,
  onToggle,
  onShowAll,
  projectName,
  selectedId,
  onOpen,
}: {
  items: WorkItem[];
  open: boolean;
  all: boolean;
  onToggle: () => void;
  onShowAll: () => void;
  projectName?: (ref: string | null) => string | undefined;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const shown = all ? items : items.slice(0, UNSCHEDULED_CAP);
  return (
    <div className="border-t wk-line-strong">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left transition hover:bg-ink/[0.03]"
      >
        <ChevronRight className={cn("size-3.5 text-ink-faint transition-transform", open && "rotate-90")} />
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
          Unscheduled <span className="tabular-nums">{items.length}</span>
        </span>
        <span className="ml-2 text-[11.5px] text-ink-faint">open items without a start or due date — open one to set its dates</span>
      </button>
      {open && (
        <ul className="flex flex-col pb-2">
          {shown.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                aria-pressed={selectedId === t.id}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 pl-8 text-left transition hover:bg-ink/[0.03]",
                  selectedId === t.id && "bg-ion/8",
                )}
              >
                <StateGlyph s={t.status} />
                <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">{t.identifier}</span>
                <span dir="auto" className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
                  {displayTitle(t)}
                </span>
                {projectName?.(t.projectRef) && <span className="wk-pill shrink-0">{projectName(t.projectRef)}</span>}
              </button>
            </li>
          ))}
          {!all && items.length > UNSCHEDULED_CAP && (
            <li>
              <button type="button" onClick={onShowAll} className="px-3 py-1.5 pl-8 text-[12px] text-ink-faint transition hover:text-ink">
                Show all {items.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
