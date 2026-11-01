"use client";

import { act } from "@/core/ui/feedback";
import { useMemo, useRef, useState, useTransition } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, RefreshCw, Video } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { useNow } from "@/core/ui/useNow";
import { HATCH, tint } from "@/modules/today/components/DayTimeline";
import { KIND_META } from "@/modules/today/timebox-kinds";
import type { TimeboxSettings } from "@/modules/today/timebox-settings";
import { createEvent, deleteEvent, requestCalendarSync } from "../actions";
import type { AgendaItem } from "../agenda";
import { EventDetail } from "./EventDetail";
import { WeekGrid } from "./WeekGrid";

const KIND_LABEL = { event: "event", timebox: "timebox" } as const;

/** How each kind of block looks on the grid. */
const LEGEND = [
  { label: "google", swatch: { background: HATCH } },
  { label: "deep box", swatch: { background: tint(KIND_META.deep.color, 40), borderLeft: `2px solid ${KIND_META.deep.color}` } },
  { label: "shallow box", swatch: { background: tint(KIND_META.shallow.color, 40), borderLeft: `2px solid ${KIND_META.shallow.color}` } },
  { label: "apOS event", swatch: { background: tint("var(--color-plasma)", 40), borderLeft: "2px solid var(--color-plasma)" } },
] as const;

const DAY_MS = 86_400_000;

const fmtTime = (d: Date) =>
  d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** "Tue 21 · 14:40" — weekday alone is ambiguous across recurring weeks. */
const fmtUpNext = (it: AgendaItem) => {
  const d = new Date(it.at);
  const day = `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
  return it.allDay ? `${day} · all day` : `${day} · ${fmtTime(d)}`;
};

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekStart = (d: Date) => addDays(d, -d.getDay());

/** ISO week number of the Monday in the Sunday-started week. */
function weekNumber(sunday: Date) {
  const mon = addDays(sunday, 1);
  const thu = addDays(mon, 3);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  return Math.floor((thu.getTime() - jan1.getTime()) / DAY_MS / 7) + 1;
}

/** "1 – 5 November", or "29 Nov – 3 Dec" across months. */
function rangeLabel(days: Date[]) {
  const a = days[0];
  const b = days[days.length - 1];
  if (days.length === 1) return a.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()} ${b.toLocaleDateString(undefined, { month: "long" })}`;
  const short = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${short(a)} – ${short(b)}`;
}

const ago = (iso: string, now: number) => {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)}h ago`;
};

function QuickAddEvent() {
  const [pending, startTransition] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);
  const whenRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const title = titleRef.current?.value.trim();
        const when = whenRef.current?.value;
        if (!title || !when || pending) return;
        startTransition(async () => {
          const r = await act(() => createEvent({ title, startAt: new Date(when) }), {
            failed: "Couldn't add the event",
          });
          if (!r.ok) return;
          if (titleRef.current) titleRef.current.value = "";
        });
      }}
      className="flex min-w-64 flex-1 items-center gap-2 rounded-lg border border-white/8 bg-white/3 py-0.5 pr-1 pl-2.5 focus-within:border-plasma/40"
    >
      <CalendarPlus className="size-3.5 shrink-0 text-plasma" />
      <input
        ref={titleRef}
        placeholder="New event…"
        disabled={pending}
        className="h-8 min-w-24 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <input
        ref={whenRef}
        type="datetime-local"
        disabled={pending}
        aria-label="When"
        className="h-7 rounded-md bg-transparent px-1.5 font-mono text-[11px] text-ink-dim outline-none [color-scheme:dark]"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-plasma/15 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
      >
        {pending ? "…" : "add"}
      </button>
    </form>
  );
}

/** The month as a navigator: click a day to show its week; the shown week's row is highlighted. */
function MiniMonth({
  items,
  month,
  onMonthChange,
  shown,
  onSelect,
  now,
}: {
  items: AgendaItem[];
  month: Date;
  onMonthChange: (d: Date) => void;
  shown: Date[];
  onSelect: (d: Date) => void;
  now: number;
}) {
  const today = new Date(now);
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = weekStart(first);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [month]);

  return (
    <div className="glass rounded-2xl p-3.5" data-testid="cal-mini-month">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-dim">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </h3>
        <div className="flex">
          <button
            type="button"
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="rounded-md p-1 text-ink-faint transition hover:bg-white/6 hover:text-ink"
            title="Previous month"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="rounded-md p-1 text-ink-faint transition hover:bg-white/6 hover:text-ink"
            title="Next month"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="pb-1 text-center font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            {d}
          </div>
        ))}
        {days.map((d, i) => {
          const dots = items.filter((it) => sameDay(new Date(it.at), d)).slice(0, 3);
          const inMonth = d.getMonth() === month.getMonth();
          const isShown = shown.some((s) => sameDay(s, d));
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(d)}
              className={cn(
                "flex h-8 flex-col items-center justify-center gap-[2px] font-mono text-[11px] tabular-nums transition",
                inMonth ? "text-ink-dim" : "text-ink-faint/40",
                isShown ? "bg-white/6" : "rounded-md hover:bg-white/4",
                isShown && shown.length === 1 && "rounded-md",
                isShown && shown.length > 1 && sameDay(d, shown[0]) && "rounded-l-md",
                isShown && shown.length > 1 && sameDay(d, shown[shown.length - 1]) && "rounded-r-md",
              )}
            >
              <span className={cn("leading-none", sameDay(d, today) && "font-semibold text-plasma")}>{d.getDate()}</span>
              <span className="flex h-[3px] gap-[2px]">
                {dots.map((it, j) => (
                  <span key={j} className="size-[3px] rounded-full" style={{ background: it.accent }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            <span className="h-2 w-3 rounded-[2px]" style={l.swatch} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CalendarView({
  items,
  settings,
  sync,
}: {
  items: AgendaItem[];
  settings: TimeboxSettings;
  sync: { google: boolean; ics: boolean; syncedAt: string | null };
}) {
  const [view, setView] = useState<"week" | "day">("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [detail, setDetail] = useState<AgendaItem | null>(null);
  const [syncPending, startSync] = useTransition();
  const [deletePending, startDelete] = useTransition();
  useLiveEvents(["calendar_changed"]);
  // Ticks each minute so the now-line and "up next" keep moving on a calendar left open.
  const now = useNow(60_000);

  // The week shows the boxable days (all seven when none are set).
  const sunday = weekStart(anchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(sunday, i)).filter(
    (d) => settings.days.length === 0 || settings.days.includes(d.getDay()),
  );
  const days = view === "week" ? weekDays : [anchor];
  const isCurrent = days.some((d) => sameDay(d, new Date(now))) || (view === "week" && sameDay(sunday, weekStart(new Date(now))));

  const goTo = (d: Date) => {
    setAnchor(d);
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  const step = (n: number) => goTo(addDays(anchor, n * (view === "week" ? 7 : 1)));

  const upcoming = items.filter((it) => new Date(it.at) >= new Date(now - 3600_000)).slice(0, 8);
  const dayNames = `${weekDays[0]?.toLocaleDateString(undefined, { weekday: "short" })}–${weekDays[weekDays.length - 1]?.toLocaleDateString(undefined, { weekday: "short" })}`;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_268px]">
      <section className="glass overflow-hidden rounded-2xl">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/6 px-4 py-3">
          <div className="flex">
            <button type="button" onClick={() => step(-1)} title={view === "week" ? "Previous week" : "Previous day"} className="rounded-md p-1.5 text-ink-dim transition hover:bg-white/6 hover:text-ink">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" onClick={() => step(1)} title={view === "week" ? "Next week" : "Next day"} className="rounded-md p-1.5 text-ink-dim transition hover:bg-white/6 hover:text-ink">
              <ChevronRight className="size-4" />
            </button>
          </div>
          <h2 className="font-display text-lg font-medium text-ink" data-testid="cal-range">
            {rangeLabel(days)}
          </h2>
          {view === "week" && (
            <span className="font-mono text-[11px] text-ink-dim">
              {dayNames} · week {weekNumber(sunday)}
            </span>
          )}
          <button
            type="button"
            onClick={() => goTo(new Date())}
            disabled={isCurrent}
            className="rounded-md border border-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition enabled:hover:border-plasma/30 enabled:hover:text-plasma disabled:cursor-default"
          >
            {isCurrent ? (view === "week" ? "this week" : "today") : "go to today"}
          </button>
          <QuickAddEvent />
          <div className="flex rounded-lg border border-white/8 p-0.5" role="tablist">
            {(["week", "day"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs capitalize transition",
                  view === v ? "bg-plasma/15 text-plasma" : "text-ink-dim hover:text-ink",
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <WeekGrid items={items} days={days} settings={settings} now={now} onOpen={setDetail} />
      </section>

      <div className="flex flex-col gap-4">
        <MiniMonth items={items} month={month} onMonthChange={setMonth} shown={days} onSelect={goTo} now={now} />

        <section className="glass rounded-2xl p-3.5">
          <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">up next</p>
          <div className="flex flex-col gap-1">
            {upcoming.length === 0 && (
              <p className="py-2 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">nothing scheduled</p>
            )}
            {upcoming.map((it) => (
              <div key={`${it.kind}:${it.id}`} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-white/4">
                <span className="dot shrink-0" style={{ color: it.accent }} />
                <span className="w-[4.5rem] shrink-0 font-mono text-[10px] leading-tight tabular-nums text-ink-faint">{fmtUpNext(it)}</span>
                <button
                  type="button"
                  dir="auto"
                  onClick={() => setDetail(it)}
                  title={`${it.title} · ${KIND_LABEL[it.kind]}`}
                  className="min-w-0 flex-1 truncate text-left text-sm text-ink-dim transition group-hover:text-ink"
                >
                  {it.title}
                </button>
                {it.meetingUrl && (
                  <a href={it.meetingUrl} target="_blank" rel="noreferrer" title="Join the call" className="shrink-0 text-plasma/70 transition hover:text-plasma">
                    <Video className="size-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="flex items-center justify-between gap-3 px-1">
          <p className="font-mono text-[10px] uppercase leading-relaxed tracking-widest text-ink-faint" data-testid="cal-sync-status">
            {sync.google
              ? `google · ${sync.syncedAt ? `synced ${ago(sync.syncedAt, now)}` : "syncs every 5 min"}`
              : sync.ics
                ? "calendar feed (ics) · every 5 min"
                : "no calendar linked — connect google in settings"}
          </p>
          <button
            type="button"
            disabled={syncPending || !(sync.google || sync.ics)}
            onClick={() =>
              startSync(async () => {
                await act(requestCalendarSync, { failed: "Couldn't start the calendar sync", done: "Calendar sync started" });
              })
            }
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-ion/30 hover:text-ion disabled:opacity-40"
          >
            <RefreshCw className={cn("size-3", syncPending && "animate-spin")} />
            sync now
          </button>
        </div>
      </div>

      <EventDetail
        item={detail}
        onClose={() => setDetail(null)}
        deletePending={deletePending}
        onDelete={(id) =>
          startDelete(async () => {
            const r = await act(() => deleteEvent(id), { failed: "Couldn't delete the event" });
            if (!r.ok) return;
            setDetail(null);
          })
        }
      />
    </div>
  );
}
