"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Plus,
  Star,
  Trash2,
  Wand2,
} from "lucide-react";
import { act } from "@/core/ui/feedback";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { atTime, ceilSlot, firstSlot, SLOT_MIN, type Interval } from "../draft-day";
import type { PlanCandidate, PlanDay } from "../plan";
import type { Timebox, TimeboxKind } from "../schema";
import { lanes, openTime } from "../timeline";
import { KIND_META } from "../timebox-kinds";
import { BoxBlock, BusyBlock, dur, GapBlock, HATCH, hhmm, NowLine, pad, TimeBar, tint } from "./DayTimeline";
import {
  clearDrafts,
  createBox,
  draftMyDay,
  lockPlan,
  removeBox,
  toggleMine,
  updateBox,
} from "../timebox-actions";

const MIN = 60_000;
const KINDS = Object.keys(KIND_META) as TimeboxKind[];
const SLOT = SLOT_MIN * MIN;
/** Vertical scale: 15 minutes = 18px. */
const PX_PER_MIN = 1.2;
const GUTTER = 56;
const DRAG_SLOP = 3;

type Span = { start: number; end: number };
type BoxDrag = { id: string; mode: "move" | "resize"; steps: number };
type NewDrag = { cand: PlanCandidate; x: number; y: number; start: number | null };

const dayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const shiftDate = (date: string, days: number) => {
  const d = dayOf(date);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function PlanBoard({ plan }: { plan: PlanDay }) {
  useLiveEvents(["calendar_changed", "attention_changed", "work_changed"]);
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const day = dayOf(plan.date);
  const origin = atTime(day, plan.settings.start).getTime();
  const close = atTime(day, plan.settings.end).getTime();
  const yOf = (t: number) => ((t - origin) / MIN) * PX_PER_MIN;
  const height = yOf(close);

  // Optimistic positions, dropped as soon as a fresh plan arrives from the server.
  const [over, setOver] = useState<{ for: PlanDay; map: Record<string, Span> }>({ for: plan, map: {} });
  const moved = over.for === plan ? over.map : {};
  const [drag, setDrag] = useState<BoxDrag | null>(null);
  const [newDrag, setNewDrag] = useState<NewDrag | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = plan.boxes.find((b) => b.id === selectedId) ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);

  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);

  // Open on now (today) or the top of the day.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const t = plan.isToday ? Date.now() : origin;
    el.scrollTo({ top: Math.max(0, ((t - origin) / MIN) * PX_PER_MIN - 90) });
  }, [plan.date, plan.isToday, origin]);

  const spanOf = (b: Timebox): Span => moved[b.id] ?? { start: new Date(b.startAt).getTime(), end: new Date(b.endAt).getTime() };
  const shown = (b: Timebox): Span => {
    const s = spanOf(b);
    if (drag?.id !== b.id) return s;
    const d = drag.steps * SLOT;
    return drag.mode === "move" ? { start: s.start + d, end: s.end + d } : { start: s.start, end: Math.max(s.start + SLOT, s.end + d) };
  };

  const save = (id: string, next: Span) => {
    setOver({ for: plan, map: { ...moved, [id]: next } });
    startSave(async () => {
      await act(() => updateBox(id, { startAt: new Date(next.start), endAt: new Date(next.end) }), {
        failed: "Couldn't move the box",
      });
      router.refresh();
    });
  };

  /** Press on a box: a click selects it, a drag moves it — or, from the bottom edge, resizes it. */
  const beginBox = (e: React.PointerEvent, b: Timebox, mode: BoxDrag["mode"]) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    let steps = 0;
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - y0) > DRAG_SLOP) dragged = true;
      const s = Math.round((ev.clientY - y0) / (SLOT_MIN * PX_PER_MIN));
      if (s !== steps || dragged) {
        steps = s;
        setDrag({ id: b.id, mode, steps: s });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (!dragged) return setSelectedId((cur) => (cur === b.id ? null : b.id));
      if (!steps) return;
      const s = spanOf(b);
      const d = steps * SLOT;
      save(b.id, mode === "move" ? { start: s.start + d, end: s.end + d } : { start: s.start, end: Math.max(s.start + SLOT, s.end + d) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Where a dragged candidate would land, or null when the pointer is off the day. */
  const slotAt = (x: number, y: number, minutes: number): number | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const min = (y - r.top + el.scrollTop) / PX_PER_MIN;
    const start = origin + Math.floor(min / SLOT_MIN) * SLOT;
    return Math.max(origin, Math.min(start, close - minutes * MIN));
  };

  const place = (cand: { ref?: string; title: string; minutes: number; kind?: TimeboxKind }, start: number) =>
    startSave(async () => {
      await act(() => createBox({ ref: cand.ref, title: cand.title, startAt: new Date(start), minutes: cand.minutes, kind: cand.kind }), {
        failed: "Couldn't add the box",
      });
      router.refresh();
    });

  /** Press on a candidate: drag it onto the day to box it. */
  const beginCandidate = (e: React.PointerEvent, cand: PlanCandidate) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("a,button")) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragged = false;
    let start: number | null = null;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > DRAG_SLOP) dragged = true;
      if (!dragged) return;
      start = slotAt(ev.clientX, ev.clientY, cand.minutes);
      setNewDrag({ cand, x: ev.clientX, y: ev.clientY, start });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setNewDrag(null);
      if (dragged && start != null) place(cand, start);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const taken = (): Interval[] => [
    ...plan.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
    ...plan.boxes.map((b) => {
      const s = spanOf(b);
      return { start: new Date(s.start), end: new Date(s.end) };
    }),
  ];
  /** The next free slot today (from now) or on the day — for the + buttons. */
  const nextFree = (minutes: number): number | null => {
    const from = plan.isToday && now != null ? Math.max(origin, now) : origin;
    return firstSlot(minutes, new Date(from), new Date(close), taken())?.start.getTime() ?? null;
  };
  const placeNext = (cand: { ref?: string; title: string; minutes: number; kind?: TimeboxKind }) => {
    const start = nextFree(cand.minutes);
    if (start == null) {
      void act(async () => ({ error: `No free ${dur(cand.minutes)} left on this day` }), { failed: "Couldn't add the box" });
      return;
    }
    place(cand, start);
  };

  const drafts = plan.boxes.filter((b) => b.status === "draft");
  const run = <T,>(fn: () => Promise<T>, failed: string, done?: (r: T) => string) =>
    startSave(async () => {
      await act(fn, { failed, done });
      router.refresh();
    });

  const hours: number[] = [];
  for (let t = origin; t <= close; t += 60 * MIN) hours.push(t);
  const focus = { start: atTime(day, plan.settings.focusStart).getTime(), end: atTime(day, plan.settings.focusEnd).getTime() };
  const shutdown = atTime(day, plan.settings.workEnd).getTime();
  const preview = newDrag?.start != null ? { start: newDrag.start, end: newDrag.start + newDrag.cand.minutes * MIN } : null;

  // Busy events and boxes share the column; clashes split it into lanes.
  const blocks = [
    ...plan.busy.map((b) => ({ busy: b, box: null, start: new Date(b.start).getTime(), end: new Date(b.end).getTime() })),
    ...plan.boxes.map((b) => ({ busy: null, box: b, ...shown(b) })),
  ].filter((x) => Math.min(x.end, close) > Math.max(x.start, origin));
  const laneOf = lanes(blocks);
  const across = (i: number): React.CSSProperties => {
    const { lane, of } = laneOf[i];
    const width = `(100% - ${GUTTER + 10}px)`;
    return { left: `calc(${GUTTER + 4}px + ${width} * ${lane / of})`, width: `calc(${width} / ${of} - ${of > 1 ? 3 : 0}px)` };
  };
  // Open time from now (today) to the shutdown: buffers and unboxed room.
  const openFrom = plan.isToday && now != null ? Math.max(origin, ceilSlot(new Date(now)).getTime()) : origin;
  const open = plan.settings.days.includes(day.getDay())
    ? openTime(
        blocks.map((x) => ({ start: new Date(x.start), end: new Date(x.end) })),
        new Date(openFrom),
        new Date(Math.min(shutdown, close)),
      )
    : [];
  const column: React.CSSProperties = { left: GUTTER + 4, right: 6 };
  const longDay = day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  return (
    <div className={cn("glass overflow-hidden rounded-2xl", (drag || newDrag) && "select-none", newDrag && "cursor-grabbing")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/6 bg-white/2 px-4 py-3">
        <div className="flex items-center">
          <Link
            href={`/m/today/plan/${shiftDate(plan.date, -1)}`}
            aria-label="Previous day"
            className="rounded-md p-1 text-ink-faint transition hover:bg-white/5 hover:text-ink"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <Link
            href={`/m/today/plan/${shiftDate(plan.date, 1)}`}
            aria-label="Next day"
            className="rounded-md p-1 text-ink-faint transition hover:bg-white/5 hover:text-ink"
          >
            <ChevronRight className="size-4" />
          </Link>
        </div>
        <h1 className="font-display text-lg font-semibold text-ink">
          Timebox {plan.isToday ? "today" : day.toLocaleDateString(undefined, { weekday: "long" })}
        </h1>
        <span className="font-mono text-[11px] text-ink-dim">
          {longDay} · boxable {plan.settings.start}–{plan.settings.end} · shutdown {plan.settings.workEnd}
        </span>
        {!plan.isToday && (
          <Link
            href="/m/today/plan"
            className="rounded-md border border-white/8 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
          >
            today
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ActionButton
            icon={Eraser}
            label="Clear drafts"
            quiet
            disabled={saving || drafts.length === 0}
            onClick={() => run(() => clearDrafts(plan.date), "Couldn't clear the drafts")}
          />
          <ActionButton
            icon={Wand2}
            label="Draft my day"
            title="Fill free time before the work shutdown with draft boxes, up to the cap"
            disabled={saving || plan.capacity.free === 0}
            onClick={() =>
              run(() => draftMyDay(plan.date), "Couldn't draft the day", (r: { drafted: number }) =>
                r.drafted ? `Drafted ${r.drafted} box${r.drafted === 1 ? "" : "es"}` : "Nothing to draft — no ★ Mine or Needs-you work fits",
              )
            }
          />
          <ActionButton
            icon={CalendarCheck}
            label={`Lock plan${drafts.length ? ` (${drafts.length})` : ""}`}
            title="Turn the drafts into planned boxes and send them to Google"
            primary
            disabled={saving || drafts.length === 0}
            onClick={() =>
              run(() => lockPlan(plan.date), "Couldn't lock the plan", (r: { locked: number }) =>
                `Locked ${r.locked} box${r.locked === 1 ? "" : "es"} — sending to Google`,
              )
            }
          />
        </div>
      </header>

      <div className="border-b border-white/6 px-4 py-3">
        <TimeBar {...plan.capacity} cap={plan.settings.draftCap} workEnd={plan.settings.workEnd} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,350px)_1fr]">
        <aside className="flex max-h-[74vh] flex-col gap-1 overflow-y-auto border-white/6 p-3.5 lg:border-r">
          <AddBox onAdd={(title) => placeNext({ title, minutes: 30, kind: "personal" })} disabled={saving} />
          <CandidateList
            title="Due or overdue"
            items={plan.due}
            more={plan.dueMore}
            empty="nothing due"
            onBegin={beginCandidate}
            onPlace={placeNext}
            onStar={(id) => run(() => toggleMine(id), "Couldn't change the owner")}
          />
          <CandidateList
            title="My items"
            items={plan.mine}
            empty="★ an item to make it yours"
            onBegin={beginCandidate}
            onPlace={placeNext}
            onStar={(id) => run(() => toggleMine(id), "Couldn't change the owner")}
          />
          <CandidateList
            title="Needs you"
            items={plan.needs}
            empty="clear"
            onBegin={beginCandidate}
            onPlace={placeNext}
          />
        </aside>

        <section className="flex min-w-0 flex-col">
          {selected && (
            <BoxDetail
              box={selected}
              span={spanOf(selected)}
              disabled={saving}
              onClose={() => setSelectedId(null)}
              onPatch={(patch, failed) => run(() => updateBox(selected.id, patch), failed)}
              onRemove={() => {
                setSelectedId(null);
                run(() => removeBox(selected.id), "Couldn't remove the box");
              }}
            />
          )}
          {plan.allDay.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-white/6 px-4 py-2">
              {plan.allDay.map((e) => (
                <span key={e.id} dir="auto" className="rounded-md px-2 py-0.5 text-xs text-ink-dim" style={{ background: HATCH }}>
                  {e.title}
                </span>
              ))}
            </div>
          )}
          <div ref={scrollRef} data-testid="plan-timeline" className="relative max-h-[74vh] overflow-y-auto">
            <div className="relative my-3" style={{ height }}>
              {/* The focus window: deep work goes here first. */}
              <div
                className="absolute bg-violet/5"
                style={{ ...column, top: yOf(focus.start), height: Math.max(0, yOf(focus.end) - yOf(focus.start)) }}
              />
              {hours.map((t) => (
                <div key={t} className="absolute right-0 border-t border-white/6" style={{ left: GUTTER - 6, top: yOf(t) }}>
                  <span className="absolute -top-[7px] font-mono text-[10px] tabular-nums text-ink-faint" style={{ right: `calc(100% + 6px)` }}>
                    {hhmm(t)}
                  </span>
                </div>
              ))}

              {open.map((g) => (
                <GapBlock
                  key={g.start.getTime()}
                  gap={g}
                  className="absolute"
                  style={{ ...column, top: yOf(g.start.getTime()) + 1, height: Math.max(10, yOf(g.end.getTime()) - yOf(g.start.getTime()) - 2) }}
                />
              ))}

              {shutdown > origin && shutdown < close && (
                <div
                  className="absolute flex items-center rounded-md px-2.5 font-mono text-[10px] text-solar"
                  style={{ ...column, top: yOf(shutdown), height: 16, borderLeft: "3px solid var(--color-solar)", background: tint("var(--color-solar)", 12) }}
                >
                  Shutdown · {plan.settings.workEnd}
                </div>
              )}

              {blocks.map((x, i) => {
                const top = yOf(Math.max(x.start, origin));
                const h = Math.max(14, yOf(Math.min(x.end, close)) - top);
                const tall = h >= 34;
                if (x.busy)
                  return (
                    <BusyBlock
                      key={x.busy.id}
                      title={x.busy.title}
                      start={x.busy.start}
                      end={x.busy.end}
                      source={x.busy.source}
                      tall={tall}
                      className="absolute z-[5]"
                      style={{ ...across(i), top, height: h - 1 }}
                    />
                  );
                const b = x.box!;
                return (
                  <BoxBlock
                    key={b.id}
                    data-box={b.id}
                    title={b.title}
                    start={x.start}
                    end={x.end}
                    kind={b.kind}
                    endMode={b.endMode}
                    draft={b.status === "draft"}
                    meta={plan.boxProjects[b.id]}
                    tall={tall}
                    selected={selectedId === b.id}
                    onPointerDown={(e) => beginBox(e, b, "move")}
                    className={cn("absolute z-10 cursor-grab shadow-sm", drag?.id === b.id && "z-20 cursor-grabbing shadow-lg")}
                    style={{ ...across(i), top, height: h - 1 }}
                  >
                    <div
                      aria-label="Resize"
                      onPointerDown={(e) => beginBox(e, b, "resize")}
                      className="absolute right-0 bottom-0 left-0 h-1.5 cursor-ns-resize hover:bg-white/20"
                    />
                  </BoxBlock>
                );
              })}

              {preview && (
                <div
                  className="pointer-events-none absolute z-30 rounded-md border border-dashed px-2.5 py-0.5 font-mono text-[10px] text-ink"
                  style={{
                    ...column,
                    top: yOf(preview.start),
                    height: yOf(preview.end) - yOf(preview.start),
                    borderColor: KIND_META[newDrag!.cand.kind].color,
                    background: `color-mix(in oklab, ${KIND_META[newDrag!.cand.kind].color} 14%, transparent)`,
                  }}
                >
                  {hhmm(preview.start)}–{hhmm(preview.end)}
                </div>
              )}

              {plan.isToday && now != null && now > origin && now < close && <NowLine style={{ left: GUTTER - 6, top: yOf(now) }} />}
            </div>
          </div>
        </section>
      </div>

      {newDrag && (
        <div
          className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border border-white/15 bg-panel/95 px-2 py-1 text-xs text-ink shadow-xl"
          style={{ left: newDrag.x + 12, top: newDrag.y + 8 }}
        >
          {newDrag.cand.title} · {dur(newDrag.cand.minutes)}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  title,
  disabled,
  onClick,
  primary,
  quiet,
}: {
  icon: typeof Wand2;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  primary?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition disabled:opacity-35",
        primary && "border-plasma bg-plasma text-void hover:bg-plasma/85",
        quiet && "border-transparent text-ink-faint hover:text-ink",
        !primary && !quiet && "border-white/10 bg-white/4 text-ink hover:bg-white/8",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function AddBox({ onAdd, disabled }: { onAdd: (title: string) => void; disabled?: boolean }) {
  const [title, setTitle] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onAdd(title.trim());
        setTitle("");
      }}
      className="flex items-center gap-2"
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="+ box — e.g. Gym, Call mom"
        aria-label="New free-text box"
        dir="auto"
        className="min-w-0 flex-1 rounded-lg border border-white/8 bg-white/4 px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-plasma/40 focus:outline-none"
      />
      <button
        type="submit"
        disabled={disabled || !title.trim()}
        title="Add a 30-minute box at the next free slot"
        className="rounded-lg border border-white/10 p-1.5 text-ink-dim transition hover:text-plasma disabled:opacity-35"
      >
        <Plus className="size-4" />
      </button>
    </form>
  );
}

const DAY = 86_400_000;
/** "due today", "overdue 2d", "due Tue" — measured from today. */
function dueLabel(due: Date | null): { text: string; late: boolean } | null {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / DAY);
  if (days < 0) return { text: `overdue ${-days}d`, late: true };
  if (days === 0) return { text: "due today", late: true };
  return { text: `due ${days === 1 ? "tomorrow" : d.toLocaleDateString(undefined, { weekday: "short" })}`, late: false };
}

const chip = "rounded-full border px-2 font-mono text-[10px] leading-[18px]";

function CandidateList({
  title,
  items,
  more = 0,
  empty,
  onBegin,
  onPlace,
  onStar,
}: {
  title: string;
  items: PlanCandidate[];
  more?: number;
  empty: string;
  onBegin: (e: React.PointerEvent, c: PlanCandidate) => void;
  onPlace: (c: PlanCandidate) => void;
  onStar?: (taskId: string) => void;
}) {
  return (
    <div>
      <p className="mt-3 mb-2 px-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {title} <span className="text-ink-faint/70">{items.length + more || ""}</span>
      </p>
      {items.length === 0 ? (
        <p className="px-0.5 font-mono text-[10px] text-ink-faint">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((c) => {
            const due = dueLabel(c.due);
            const isTask = c.ref.startsWith("task:");
            return (
              <li
                key={c.ref}
                data-ref={c.ref}
                onPointerDown={(e) => onBegin(e, c)}
                title={c.boxed ? "Boxed on this day — drag to box it again" : "Drag onto the day to box it"}
                className={cn(
                  "group relative cursor-grab rounded-[9px] border border-white/8 bg-white/3 px-3 py-2 transition hover:border-white/16 hover:bg-white/5",
                  c.boxed && "opacity-40",
                )}
                style={{ borderLeft: `2px solid ${KIND_META[c.kind].color}` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span dir="auto" className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-ink">
                    {c.title}
                  </span>
                  <span className="mt-px shrink-0 font-mono text-[11px] tabular-nums text-ink-dim">
                    {c.tooBig && c.points ? `${c.points} pts → ${dur(c.minutes)}+` : `~${dur(c.minutes)}`}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {due && <span className={cn(chip, due.late ? "border-flare/35 text-flare" : "border-white/10 text-ink-dim")}>{due.text}</span>}
                  {c.project && <span className={cn(chip, "border-white/10 text-ink-dim")}>{c.project}</span>}
                  {!isTask && <span className={cn(chip, "border-solar/35 text-solar")}>attention card</span>}
                  {onStar && isTask && (
                    <button
                      type="button"
                      aria-label={c.mine ? "Not mine" : "Mark as mine"}
                      title={c.mine ? "Mine — click to let it go" : "Mark as mine"}
                      onClick={() => onStar(c.ref.slice(5))}
                      className={cn(
                        chip,
                        "flex items-center gap-1 transition",
                        c.mine ? "border-ion/35 text-ion" : "border-transparent text-ink-faint/60 hover:text-gold",
                      )}
                    >
                      <Star className={cn("size-2.5", c.mine && "fill-current")} />
                      {c.mine && "mine"}
                    </button>
                  )}
                  {c.tooBig && (
                    <span className={cn(chip, "border-solar/35 text-solar")} title="5+ points won't fit one box">
                      too big, split it
                    </span>
                  )}
                  {c.identifier && <span className="font-mono text-[10px] text-ink-faint">{c.identifier}</span>}
                  <span className="absolute right-1.5 bottom-1.5 flex items-center gap-0.5 rounded-md bg-panel/90 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    {c.boxed ? (
                      <span className="sr-only">boxed</span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Box ${c.title} at the next free slot`}
                        title="Box it at the next free slot"
                        onClick={() => onPlace(c)}
                        className="rounded p-0.5 text-ink-faint transition hover:text-plasma"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    )}
                    {c.href && (
                      <Link
                        href={c.href}
                        aria-label="Open"
                        className="rounded p-0.5 text-ink-faint transition hover:text-ink"
                      >
                        <ArrowUpRight className="size-3.5" />
                      </Link>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && <p className="px-0.5 pt-2 font-mono text-[10px] text-ink-faint">+{more} more due</p>}
    </div>
  );
}

function BoxDetail({
  box,
  span,
  disabled,
  onClose,
  onPatch,
  onRemove,
}: {
  box: Timebox;
  span: Span;
  disabled?: boolean;
  onClose: () => void;
  onPatch: (patch: Parameters<typeof updateBox>[1], failed: string) => void;
  onRemove: () => void;
}) {
  const draft = box.status === "draft";
  const href = box.taskId ? `/m/tasks/${box.taskId}` : box.attentionId ? "/m/today/queue" : null;
  return (
    <div data-testid="box-detail" className="flex flex-wrap items-center gap-2 border-b border-white/6 px-4 py-2.5">
      <span className="font-mono text-[10px] tabular-nums text-ink-faint">
        {hhmm(span.start)}–{hhmm(span.end)}
      </span>
      <span dir="auto" className="min-w-0 max-w-72 truncate text-sm font-medium text-ink">
        {box.title}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
        {draft ? "draft" : box.syncState === "synced" ? "in google" : box.syncState === "error" ? "sync error" : "syncing"}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => onPatch({ kind: k }, "Couldn't change the kind")}
            className={cn(
              "rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition",
              box.kind === k ? "text-ink" : "border-transparent text-ink-faint hover:text-ink",
            )}
            style={box.kind === k ? { borderColor: KIND_META[k].color } : undefined}
          >
            {KIND_META[k].label}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          title="Soft: may run over into the next box. Hard: stop at the end."
          onClick={() => onPatch({ endMode: box.endMode === "hard" ? "soft" : "hard" }, "Couldn't change the end")}
          className="ml-1 rounded-md border border-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
        >
          {box.endMode} end
        </button>
        {href && (
          <Link
            href={href}
            className="flex items-center gap-0.5 rounded-md px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
          >
            open <ArrowUpRight className="size-3" />
          </Link>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          title={draft ? "Remove the draft" : "Drop the box (it leaves Google)"}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-flare/80 transition hover:bg-flare/10 hover:text-flare"
        >
          <Trash2 className="size-3" />
          {draft ? "remove" : "drop"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md px-1.5 py-0.5 font-mono text-[10px] text-ink-faint transition hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
