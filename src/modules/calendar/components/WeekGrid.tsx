"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Video } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { BoxBlock, BusyBlock, dur, HATCH, hhmm, NowLine, pad, tint } from "@/modules/today/components/DayTimeline";
import { capacity, workWindow } from "@/modules/today/draft-day";
import { lanes } from "@/modules/today/timeline";
import type { TimeboxSettings } from "@/modules/today/timebox-settings";
import type { AgendaItem } from "../agenda";

/**
 * The Calendar's week (or single day) on the Plan screen's timeline pieces:
 * Google time hatched, boxes tinted by kind, the focus window tinted, the
 * shutdown line and the now-line. Each day header shows the day's free and
 * boxed time and opens its Plan screen.
 */

const MIN = 60_000;
const HOUR_PX = 52;
const GUTTER = 52;

const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const atTime = (day: Date, t: string) => {
  const [h, m] = t.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
};
const endOf = (it: AgendaItem) => (it.endAt ? new Date(it.endAt).getTime() : new Date(it.at).getTime() + 30 * MIN);

interface Placed {
  item: AgendaItem;
  start: number;
  end: number;
}

/** The day's timed items, clipped to the day — an event crossing midnight shows in both columns. */
function timedOn(items: AgendaItem[], day: Date): Placed[] {
  const from = dayStart(day).getTime();
  const to = from + 24 * 60 * MIN;
  return items
    .filter((it) => !it.allDay)
    .map((item) => ({ item, start: Math.max(from, new Date(item.at).getTime()), end: Math.min(to, endOf(item)) }))
    .filter((p) => p.end > p.start);
}

function DayHeader({
  day,
  placed,
  settings,
  now,
}: {
  day: Date;
  placed: Placed[];
  settings: TimeboxSettings;
  now: number;
}) {
  const today = localDate(day) === localDate(new Date(now));
  const past = dayStart(day).getTime() < dayStart(new Date(now)).getTime();
  const span = (p: Placed) => ({ start: new Date(p.start), end: new Date(p.end) });
  const window = workWindow(day, new Date(now), settings);
  const { free, boxed } = capacity(
    window,
    placed.filter((p) => p.item.busy).map(span),
    placed.filter((p) => p.item.box).map(span),
  );
  const boxable = settings.days.includes(day.getDay());
  const over = free ? boxed / free : 0;
  const note = !boxable
    ? "not a box day"
    : past
      ? "past"
      : !window
        ? "work day over"
        : null;

  return (
    <Link
      href={`/m/today/plan/${localDate(day)}`}
      title="Plan this day"
      data-testid="cal-day-header"
      className="group block min-w-0 px-2.5 pt-2.5 pb-2 transition hover:bg-white/3"
    >
      <span className="flex items-baseline gap-1.5">
        <span className={cn("font-mono text-[10px] uppercase tracking-widest", today ? "text-plasma" : "text-ink-faint")}>
          {day.toLocaleDateString(undefined, { weekday: "short" })}
        </span>
        <span className={cn("font-display text-lg leading-none", today ? "text-plasma" : "text-ink-dim")}>{day.getDate()}</span>
        <span
          className={cn(
            "ml-auto font-mono text-[10px] text-plasma transition",
            today ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          Plan →
        </span>
      </span>
      <span className="mt-2 block h-[3px] overflow-hidden rounded-full bg-white/6">
        {free > 0 && (
          <i
            className={cn("block h-full", over > 1 ? "bg-flare" : over > settings.draftCap ? "bg-solar" : "bg-violet")}
            style={{ width: `${Math.min(100, over * 100)}%` }}
          />
        )}
      </span>
      <span className="mt-1.5 block font-mono text-[10px] leading-snug text-ink-faint">
        {note ?? (
          <>
            <span className="block truncate">{dur(free)} free</span>
            <span className={cn("block truncate", over > settings.draftCap && "text-solar/80")}>{boxed ? `${dur(boxed)} boxed` : "nothing boxed"}</span>
          </>
        )}
      </span>
    </Link>
  );
}

function Block({
  p,
  style,
  narrow,
  onOpen,
}: {
  p: Placed;
  style: CSSProperties;
  narrow: boolean;
  onOpen: (it: AgendaItem) => void;
}) {
  const { item } = p;
  const h = Number(style.height);
  const tall = h >= 34;
  const inner = item.box ? (
    <BoxBlock
      title={item.title}
      start={p.start}
      end={p.end}
      kind={item.box.kind}
      endMode={item.box.endMode}
      done={item.box.done}
      noChip={narrow}
      tall={tall}
      className={cn("h-full shadow-sm", item.box.done && "opacity-75")}
    />
  ) : item.source === "local" ? (
    <div
      className={cn("h-full overflow-hidden rounded-md px-2.5 text-[13px] leading-tight text-ink", tall ? "py-1" : "flex items-center gap-2")}
      style={{ borderLeft: `3px solid ${item.accent}`, background: tint(item.accent, 16) }}
    >
      <span dir="auto" className={cn("truncate font-medium", tall && "block")}>
        {item.title}
      </span>
      <span className={cn("truncate font-mono text-[10px] text-ink-dim", tall && "block")}>
        apOS · {hhmm(p.start)}–{hhmm(p.end)}
      </span>
    </div>
  ) : (
    <BusyBlock
      title={item.title}
      start={p.start}
      end={p.end}
      source={item.source === "ics" ? "ics" : "google"}
      tall={tall}
      className={cn("h-full", !item.busy && "opacity-50")}
    />
  );
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="cal-block"
      title={`${item.title} · ${hhmm(p.start)}–${hhmm(p.end)}${item.busy || item.box || item.source === "local" ? "" : " · doesn't hold the time (free or declined)"}`}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen(item)}
      className="absolute cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-plasma/60"
      style={style}
    >
      {inner}
      {item.meetingUrl && h >= 44 && (
        <a
          href={item.meetingUrl}
          target="_blank"
          rel="noreferrer"
          title="Join the call"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1.5 bottom-1 flex items-center gap-1 rounded-md border border-plasma/25 bg-panel/90 px-1.5 font-mono text-[9px] uppercase leading-4 tracking-widest text-plasma transition hover:bg-plasma/20"
        >
          <Video className="size-3" />
          join
        </a>
      )}
    </div>
  );
}

export function WeekGrid({
  items,
  days,
  settings,
  now,
  onOpen,
}: {
  items: AgendaItem[];
  days: Date[];
  settings: TimeboxSettings;
  now: number;
  onOpen: (it: AgendaItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Column width, to drop the kind chip from blocks too narrow for it.
  const [colWidth, setColWidth] = useState(200);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setColWidth((el.clientWidth - GUTTER) / days.length));
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length]);
  const placed = days.map((d) => timedOn(items, d));
  const allDay = days.map((d) => items.filter((it) => it.allDay && localDate(new Date(it.at)) === localDate(d)));

  // Hours shown: an hour before the boxable start to an hour past the shutdown,
  // stretched for anything earlier or later in the shown days.
  const hourOf = (t: string) => Number(t.split(":")[0]);
  let first = Math.max(0, hourOf(settings.start) - 1);
  let last = Math.min(24, hourOf(settings.workEnd) + 1);
  placed.forEach((ps, i) => {
    const base = dayStart(days[i]).getTime();
    for (const p of ps) {
      first = Math.min(first, Math.floor((p.start - base) / (60 * MIN)));
      last = Math.max(last, Math.ceil((p.end - base) / (60 * MIN)));
    }
  });
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const height = (last - first) * HOUR_PX;
  const yOf = (day: Date, t: number) => ((t - dayStart(day).getTime()) / MIN / 60 - first) * HOUR_PX;

  // Open on the now-line (or the focus window when today isn't shown).
  const todayIdx = days.findIndex((d) => localDate(d) === localDate(new Date(now)));
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const d = days[Math.max(0, todayIdx)];
    const t = todayIdx >= 0 ? now : atTime(d, settings.focusStart);
    el.scrollTo({ top: Math.max(0, yOf(d, t) - 120) });
    // Only when the shown range changes, not on every minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDate(days[0]), days.length]);

  const cols: CSSProperties = { gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div data-testid="cal-week">
      <div className="grid border-b border-white/6" style={cols}>
        <span />
        {days.map((d, i) => (
          <div key={localDate(d)} className="border-l border-white/6">
            <DayHeader day={d} placed={placed[i]} settings={settings} now={now} />
          </div>
        ))}
      </div>
      {allDay.some((a) => a.length > 0) && (
        <div className="grid border-b border-white/6" style={cols}>
          <span className="self-center pr-2 text-right font-mono text-[9px] uppercase leading-tight tracking-widest text-ink-faint">all day</span>
          {allDay.map((list, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1 border-l border-white/6 p-1">
              {list.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  dir="auto"
                  onClick={() => onOpen(it)}
                  className="truncate rounded-md border-l-[3px] border-ink-faint/60 px-2 py-0.5 text-left text-xs text-ink-dim transition hover:text-ink"
                  style={{ background: HATCH }}
                >
                  {it.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={scrollRef} className="relative max-h-[68vh] overflow-y-auto">
        <div className="relative grid" style={{ ...cols, height }}>
          <div className="relative">
            {hours.map((h) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-ink-faint"
                style={{ top: (h - first) * HOUR_PX }}
              >
                {h > first && h < last ? `${pad(h % 24)}:00` : ""}
              </span>
            ))}
          </div>
          {days.map((d, i) => {
            const isToday = i === todayIdx;
            const boxable = settings.days.includes(d.getDay());
            const startOfDay = dayStart(d).getTime();
            const pastUntil = isToday ? now : startOfDay < dayStart(new Date(now)).getTime() ? startOfDay + 24 * 60 * MIN : null;
            const shutdown = atTime(d, settings.workEnd);
            const laneOf = lanes(placed[i]);
            return (
              <div key={localDate(d)} className="relative border-l border-white/6">
                {hours.slice(1, -1).map((h) => (
                  <div key={h} className="absolute inset-x-0 border-t border-white/5" style={{ top: (h - first) * HOUR_PX }} />
                ))}
                {boxable && (
                  <div
                    className="absolute inset-x-0 bg-violet/5"
                    style={{ top: yOf(d, atTime(d, settings.focusStart)), height: yOf(d, atTime(d, settings.focusEnd)) - yOf(d, atTime(d, settings.focusStart)) }}
                  />
                )}
                {pastUntil != null && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-void/35" style={{ height: Math.max(0, yOf(d, pastUntil)) }} />
                )}
                {boxable && (
                  <div className="absolute inset-x-0 z-[1] border-t border-solar/70" style={{ top: yOf(d, shutdown) }}>
                    <span className="absolute right-1.5 -top-3.5 font-mono text-[9px] text-solar/80">shutdown</span>
                  </div>
                )}
                {placed[i].map((p, j) => {
                  const { lane, of } = laneOf[j];
                  const top = yOf(d, p.start);
                  const h = Math.max(16, yOf(d, p.end) - top) - 2;
                  return (
                    <Block
                      key={`${p.item.kind}:${p.item.id}`}
                      p={p}
                      narrow={colWidth / of < 190}
                      onOpen={onOpen}
                      style={{
                        top: top + 1,
                        height: h,
                        left: `calc(4px + (100% - 8px) * ${lane / of})`,
                        width: `calc((100% - 8px) / ${of} - ${of > 1 ? 3 : 0}px)`,
                        zIndex: p.item.box ? 10 : 5,
                      }}
                    />
                  );
                })}
                {isToday && <NowLine style={{ left: 0, top: yOf(d, now) }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
