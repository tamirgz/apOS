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
  Lock,
  Plus,
  Star,
  Trash2,
  Wand2,
} from "lucide-react";
import { act } from "@/core/ui/feedback";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { atTime, firstSlot, SLOT_MIN, type Interval } from "../draft-day";
import type { PlanCandidate, PlanDay } from "../plan";
import type { Timebox, TimeboxKind } from "../schema";
import { KIND_META } from "../timebox-kinds";
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
const GUTTER = 48;
const DRAG_SLOP = 3;

type Span = { start: number; end: number };
type BoxDrag = { id: string; mode: "move" | "resize"; steps: number };
type NewDrag = { cand: PlanCandidate; x: number; y: number; start: number | null };

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (t: number | Date) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${pad(min % 60)}m` : ""}` : `${min}m`);
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

  return (
    <div className={cn("flex flex-col gap-4", (drag || newDrag) && "select-none", newDrag && "cursor-grabbing")}>
      <header className="flex flex-wrap items-center gap-3 px-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-solar">plan</p>
        <div className="flex items-center gap-1">
          <Link
            href={`/m/today/plan/${shiftDate(plan.date, -1)}`}
            aria-label="Previous day"
            className="rounded-md p-1 text-ink-faint transition hover:bg-white/5 hover:text-ink"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <h1 className="min-w-44 text-center font-display text-lg font-semibold text-ink">
            {day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </h1>
          <Link
            href={`/m/today/plan/${shiftDate(plan.date, 1)}`}
            aria-label="Next day"
            className="rounded-md p-1 text-ink-faint transition hover:bg-white/5 hover:text-ink"
          >
            <ChevronRight className="size-4" />
          </Link>
          {!plan.isToday && (
            <Link
              href="/m/today/plan"
              className="ml-1 rounded-md border border-white/8 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
            >
              today
            </Link>
          )}
        </div>
        <Capacity {...plan.capacity} cap={plan.settings.draftCap} workEnd={plan.settings.workEnd} />
        <div className="ml-auto flex items-center gap-2">
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
            tone="plasma"
          />
          <ActionButton
            icon={Eraser}
            label="Clear drafts"
            disabled={saving || drafts.length === 0}
            onClick={() => run(() => clearDrafts(plan.date), "Couldn't clear the drafts")}
          />
          <ActionButton
            icon={CalendarCheck}
            label={`Lock plan${drafts.length ? ` (${drafts.length})` : ""}`}
            title="Turn the drafts into planned boxes and send them to Google"
            disabled={saving || drafts.length === 0}
            onClick={() =>
              run(() => lockPlan(plan.date), "Couldn't lock the plan", (r: { locked: number }) =>
                `Locked ${r.locked} box${r.locked === 1 ? "" : "es"} — sending to Google`,
              )
            }
            tone="solar"
          />
        </div>
      </header>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(280px,360px)_1fr]">
        <aside className="glass flex max-h-[78vh] flex-col gap-4 overflow-y-auto rounded-2xl p-4">
          <AddBox onAdd={(title) => placeNext({ title, minutes: 30, kind: "personal" })} disabled={saving} />
          <CandidateList
            title="Due"
            items={plan.due}
            more={plan.dueMore}
            empty="nothing due"
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
          <CandidateList
            title="Mine"
            items={plan.mine}
            empty="★ an item to make it yours"
            onBegin={beginCandidate}
            onPlace={placeNext}
            onStar={(id) => run(() => toggleMine(id), "Couldn't change the owner")}
          />
        </aside>

        <section className="glass flex flex-col overflow-hidden rounded-2xl">
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
                <span key={e.id} dir="auto" className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-ink-dim">
                  {e.title}
                </span>
              ))}
            </div>
          )}
          <div ref={scrollRef} data-testid="plan-timeline" className="relative max-h-[72vh] overflow-y-auto">
            <div className="relative" style={{ height }}>
              {/* The focus window and the work shutdown. */}
              <div
                className="absolute right-0 bg-violet/4"
                style={{ left: GUTTER, top: yOf(focus.start), height: Math.max(0, yOf(focus.end) - yOf(focus.start)) }}
              />
              {hours.map((t) => (
                <div key={t} className="absolute right-0 left-0 border-t border-white/6" style={{ top: yOf(t) }}>
                  <span className="absolute -top-2 left-2 font-mono text-[10px] tabular-nums text-ink-faint">{hhmm(t)}</span>
                </div>
              ))}
              {shutdown > origin && shutdown < close && (
                <div className="absolute right-0 border-t border-dashed border-solar/40" style={{ left: GUTTER, top: yOf(shutdown) }}>
                  <span className="absolute -top-4 right-2 font-mono text-[9px] uppercase tracking-widest text-solar/70">
                    shutdown
                  </span>
                </div>
              )}

              {plan.busy.map((b) => {
                const s = Math.max(new Date(b.start).getTime(), origin);
                const e = Math.min(new Date(b.end).getTime(), close);
                if (e <= s) return null;
                return (
                  <div
                    key={b.id}
                    title={`${b.title} · ${hhmm(b.start)}–${hhmm(b.end)}`}
                    className="absolute right-1 flex items-start gap-1 overflow-hidden rounded-md border border-white/8 bg-white/5 px-2 py-0.5 text-[11px] text-ink-faint"
                    style={{ left: GUTTER + 2, top: yOf(s), height: Math.max(14, yOf(e) - yOf(s)) }}
                  >
                    <Lock className="mt-0.5 size-3 shrink-0" />
                    <span dir="auto" className="truncate">
                      {b.title}
                    </span>
                  </div>
                );
              })}

              {plan.boxes.map((b) => {
                const s = shown(b);
                const top = yOf(Math.max(s.start, origin));
                const h = yOf(Math.min(s.end, close)) - top;
                if (h <= 0) return null;
                const color = KIND_META[b.kind].color;
                const draft = b.status === "draft";
                return (
                  <div
                    key={b.id}
                    data-box={b.id}
                    onPointerDown={(e) => beginBox(e, b, "move")}
                    className={cn(
                      "absolute right-1 z-10 cursor-grab overflow-hidden rounded-md border px-2 py-0.5 text-xs text-ink shadow-sm transition-[box-shadow]",
                      draft ? "border-dashed" : "border-solid",
                      selectedId === b.id && "ring-1 ring-white/50",
                      drag?.id === b.id && "z-20 cursor-grabbing shadow-lg",
                    )}
                    style={{
                      left: GUTTER + 40,
                      top,
                      height: Math.max(14, h),
                      borderColor: color,
                      borderLeftWidth: 3,
                      background: `color-mix(in oklab, ${color} ${draft ? 10 : 20}%, var(--color-panel))`,
                    }}
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-dim">
                        {hhmm(s.start)}–{hhmm(s.end)}
                      </span>
                      <span dir="auto" className="truncate font-medium">
                        {b.title}
                      </span>
                      {b.endMode === "hard" && <span className="shrink-0 font-mono text-[9px] uppercase text-flare/80">hard</span>}
                      {draft && <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">draft</span>}
                    </div>
                    <div
                      aria-label="Resize"
                      onPointerDown={(e) => beginBox(e, b, "resize")}
                      className="absolute right-0 bottom-0 left-0 h-1.5 cursor-ns-resize hover:bg-white/20"
                    />
                  </div>
                );
              })}

              {preview && (
                <div
                  className="pointer-events-none absolute right-1 z-30 rounded-md border border-dashed px-2 py-0.5 font-mono text-[10px] text-ink"
                  style={{
                    left: GUTTER + 40,
                    top: yOf(preview.start),
                    height: yOf(preview.end) - yOf(preview.start),
                    borderColor: KIND_META[newDrag!.cand.kind].color,
                    background: `color-mix(in oklab, ${KIND_META[newDrag!.cand.kind].color} 14%, transparent)`,
                  }}
                >
                  {hhmm(preview.start)}–{hhmm(preview.end)}
                </div>
              )}

              {plan.isToday && now != null && now > origin && now < close && (
                <div className="pointer-events-none absolute right-0 z-30 border-t border-flare" style={{ left: GUTTER - 6, top: yOf(now) }}>
                  <span className="absolute -top-[4px] -left-[4px] size-2 rounded-full bg-flare" />
                </div>
              )}
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

function Capacity({ free, boxed, cap, workEnd }: { free: number; boxed: number; cap: number; workEnd: string }) {
  if (free === 0)
    return <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">no work time left on this day</span>;
  const pct = boxed / free;
  const tone = pct > 1 ? "bg-flare" : pct > cap ? "bg-solar" : "bg-plasma";
  return (
    <div className="flex items-center gap-2" title={`Boxed time ÷ free time before ${workEnd}. Keep it under ${Math.round(cap * 100)}%.`}>
      <div data-testid="capacity" className="relative h-2 w-40 overflow-hidden rounded-full bg-white/8">
        <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${Math.min(pct, 1) * 100}%` }} />
        <div className="absolute top-0 h-full w-px bg-ink/70" style={{ left: `${cap * 100}%` }} />
      </div>
      <span className={cn("font-mono text-[10px] tabular-nums", pct > cap ? "text-solar" : "text-ink-dim")}>
        {Math.round(pct * 100)}% · {dur(Math.round(boxed))} of {dur(Math.round(free))} before {workEnd}
      </span>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  title,
  disabled,
  onClick,
  tone,
}: {
  icon: typeof Wand2;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  tone?: "plasma" | "solar";
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-35",
        tone === "plasma" && "border-plasma/30 text-plasma hover:bg-plasma/10",
        tone === "solar" && "border-solar/30 text-solar hover:bg-solar/10",
        !tone && "border-white/10 text-ink-dim hover:bg-white/5 hover:text-ink",
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (
    <div>
      <p className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {title} <span className="text-ink-faint/70">{items.length + more || ""}</span>
      </p>
      {items.length === 0 ? (
        <p className="px-1 py-1 font-mono text-[10px] text-ink-faint">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((c) => {
            const overdue = c.due && new Date(c.due) < today;
            const isTask = c.ref.startsWith("task:");
            return (
              <li
                key={c.ref}
                data-ref={c.ref}
                onPointerDown={(e) => onBegin(e, c)}
                title="Drag onto the day to box it"
                className={cn(
                  "group flex cursor-grab items-center gap-1.5 rounded-lg px-1.5 py-1 transition hover:bg-white/4",
                  c.boxed && "opacity-45",
                )}
              >
                <span className="h-4 w-0.5 shrink-0 rounded-full" style={{ background: KIND_META[c.kind].color }} />
                {onStar && isTask && (
                  <button
                    type="button"
                    aria-label={c.mine ? "Not mine" : "Mark as mine"}
                    title={c.mine ? "Mine — click to let it go" : "Mark as mine"}
                    onClick={() => onStar(c.ref.slice(5))}
                    className={cn("shrink-0 transition", c.mine ? "text-gold" : "text-ink-faint/50 hover:text-gold")}
                  >
                    <Star className={cn("size-3.5", c.mine && "fill-current")} />
                  </button>
                )}
                {c.identifier && <span className="shrink-0 font-mono text-[10px] text-ink-faint">{c.identifier}</span>}
                <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-ink-dim group-hover:text-ink">
                  {c.title}
                </span>
                {c.tooBig && (
                  <span className="shrink-0 font-mono text-[9px] uppercase text-solar" title="5+ points won't fit one box">
                    too big, split it
                  </span>
                )}
                {overdue && <span className="shrink-0 font-mono text-[9px] uppercase text-flare">overdue</span>}
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{dur(c.minutes)}</span>
                {c.boxed ? (
                  <span className="shrink-0 font-mono text-[9px] uppercase text-plasma">boxed</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Box ${c.title} at the next free slot`}
                    title="Box it at the next free slot"
                    onClick={() => onPlace(c)}
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-plasma focus:opacity-100"
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
                {c.href && (
                  <Link
                    href={c.href}
                    aria-label="Open"
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-ink focus:opacity-100"
                  >
                    <ArrowUpRight className="size-3.5" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && <p className="px-1 pt-1 font-mono text-[10px] text-ink-faint">+{more} more due</p>}
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
