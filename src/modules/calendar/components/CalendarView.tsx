"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Trash2,
  Video,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { useNow } from "@/core/ui/useNow";
import { createEvent, deleteEvent, requestIcsSync } from "../actions";
import type { AgendaItem } from "../agenda";
import { EventDetail } from "./EventDetail";

const KIND_LABEL = { event: "event", task: "due" } as const;

/** Category fallback colors — Google events use their own color when set. */
const LEGEND = [
  { label: "google", color: "var(--color-ion)" },
  { label: "apOS event", color: "var(--color-plasma)" },
  { label: "task due", color: "var(--color-solar)" },
] as const;

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
          await createEvent({ title, startAt: new Date(when) });
          if (titleRef.current) titleRef.current.value = "";
        });
      }}
      className="glass mb-4 flex flex-wrap items-center gap-2 rounded-xl p-1.5 pl-3 focus-within:glass-edge"
    >
      <CalendarPlus className="size-4 text-plasma" />
      <input
        ref={titleRef}
        placeholder="New event…"
        disabled={pending}
        className="h-9 min-w-40 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <input
        ref={whenRef}
        type="datetime-local"
        disabled={pending}
        className="h-9 rounded-lg border border-white/8 bg-abyss/60 px-3 font-mono text-xs text-ink outline-none focus:border-plasma/40 [color-scheme:dark]"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-plasma/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
      >
        {pending ? "…" : "add"}
      </button>
    </form>
  );
}

function MonthGrid({
  items,
  month,
  onMonthChange,
  selected,
  onSelect,
}: {
  items: AgendaItem[];
  month: Date;
  onMonthChange: (d: Date) => void;
  selected: Date;
  onSelect: (d: Date) => void;
}) {
  const today = new Date();
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    // Week starts Sunday.
    const gridStart = new Date(first);
    gridStart.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }, [month]);

  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-lg font-medium text-ink">
          {month.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </h3>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() =>
              onMonthChange(
                new Date(month.getFullYear(), month.getMonth() - 1, 1),
              )
            }
            className="rounded-md p-1.5 text-ink-dim transition hover:bg-white/6 hover:text-ink"
            title="Previous month"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              onMonthChange(
                new Date(month.getFullYear(), month.getMonth() + 1, 1),
              )
            }
            className="rounded-md p-1.5 text-ink-dim transition hover:bg-white/6 hover:text-ink"
            title="Next month"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div
            key={i}
            className="pb-1 text-center font-mono text-[9px] uppercase tracking-widest text-ink-faint"
          >
            {d}
          </div>
        ))}
        {days.map((d, i) => {
          const dayItems = items.filter((it) => sameDay(new Date(it.at), d));
          const inMonth = d.getMonth() === month.getMonth();
          const isToday = sameDay(d, today);
          const isSelected = sameDay(d, selected);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(d)}
              className={cn(
                "flex h-11 flex-col items-center justify-start gap-0.5 rounded-lg pt-0.5 transition",
                inMonth ? "text-ink-dim" : "text-ink-faint/50",
                isSelected && "glass-edge bg-white/4",
                !isSelected && "hover:bg-white/4",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full font-mono text-[11px] tabular-nums",
                  isToday && "bg-plasma/20 font-semibold text-plasma",
                )}
              >
                {d.getDate()}
              </span>
              <span className="flex items-center gap-[3px]">
                {dayItems.slice(0, 4).map((it, j) => (
                  <span
                    key={j}
                    className="size-[5px] rounded-full"
                    style={{
                      background: it.accent,
                      boxShadow: `0 0 4px ${it.accent}`,
                    }}
                  />
                ))}
                {dayItems.length > 4 && (
                  <span className="font-mono text-[8px] leading-none text-ink-faint">
                    +{dayItems.length - 4}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarView({
  items,
  hasIcs,
}: {
  items: AgendaItem[];
  hasIcs: boolean;
}) {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [selected, setSelected] = useState(() => new Date());
  const [detail, setDetail] = useState<AgendaItem | null>(null);
  const [syncPending, startSync] = useTransition();
  const [deletePending, startDelete] = useTransition();
  useLiveEvents(["calendar_changed"]);
  // Ticks each minute so "upcoming" keeps moving on a calendar left open.
  const now = useNow(60_000);

  const dayItems = items.filter((it) => sameDay(new Date(it.at), selected));
  const upcoming = items
    .filter((it) => new Date(it.at) >= new Date(now - 3600_000))
    .slice(0, 8);

  return (
    <div>
      <QuickAddEvent />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <MonthGrid
            items={items}
            month={month}
            onMonthChange={setMonth}
            selected={selected}
            onSelect={setSelected}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
            {LEGEND.map((l) => (
              <span
                key={l.label}
                className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint"
              >
                <span
                  className="size-[5px] rounded-full"
                  style={{ background: l.color, boxShadow: `0 0 4px ${l.color}` }}
                />
                {l.label}
              </span>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between px-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {hasIcs
                ? "google calendar synced via ics · every 5 min"
                : "no google calendar linked — add your ICS url in settings"}
            </p>
            <button
              type="button"
              disabled={syncPending || !hasIcs}
              onClick={() =>
                startSync(async () => {
                  await requestIcsSync();
                })
              }
              className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-ion/30 hover:text-ion disabled:opacity-40"
            >
              <RefreshCw className={cn("size-3", syncPending && "animate-spin")} />
              sync now
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <section className="glass rounded-2xl p-4">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-plasma">
              {sameDay(selected, new Date())
                ? "today"
                : selected.toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
            </p>
            {dayItems.length === 0 && (
              <p className="py-4 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                clear
              </p>
            )}
            <div className="flex flex-col gap-2">
              {dayItems.map((it) => (
                <motion.div
                  key={`${it.kind}:${it.id}`}
                  layout
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/4"
                >
                  <span className="dot shrink-0" style={{ color: it.accent }} />
                  <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-faint">
                    {it.allDay ? "all day" : fmtTime(new Date(it.at))}
                  </span>
                  {it.kind === "task" ? (
                    <Link
                      href={it.href}
                      dir="auto"
                      className="flex-1 truncate text-left text-sm text-ink-dim transition group-hover:text-ink"
                    >
                      {it.title}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      dir="auto"
                      onClick={() => setDetail(it)}
                      className="flex-1 truncate text-left text-sm text-ink-dim transition group-hover:text-ink"
                    >
                      {it.title}
                    </button>
                  )}
                  {/* One click to the call — no need to open the panel first. */}
                  {it.meetingUrl && (
                    <a
                      href={it.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Join the call"
                      onClick={(e) => e.stopPropagation()}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-plasma/25 bg-plasma/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-plasma transition hover:bg-plasma/20"
                    >
                      <Video className="size-3" />
                      join
                    </a>
                  )}
                  <span
                    className="font-mono text-[9px] uppercase tracking-widest"
                    style={{ color: it.accent }}
                  >
                    {KIND_LABEL[it.kind]}
                  </span>
                  {it.deletable && (
                    <button
                      type="button"
                      title="Delete event"
                      onClick={() =>
                        startDelete(async () => {
                          await deleteEvent(it.id);
                        })
                      }
                      className="invisible rounded-md p-1 text-ink-faint transition hover:text-flare group-hover:visible"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </motion.div>
              ))}
            </div>
          </section>

          <section className="glass rounded-2xl p-4">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
              up next
            </p>
            <div className="flex flex-col gap-1.5">
              {upcoming.length === 0 && (
                <p className="py-2 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                  nothing scheduled
                </p>
              )}
              {upcoming.map((it) => (
                <div
                  key={`${it.kind}:${it.id}`}
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-1 transition hover:bg-white/4"
                >
                  <span className="dot shrink-0" style={{ color: it.accent }} />
                  <span className="w-24 shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
                    {fmtUpNext(it)}
                  </span>
                  {it.kind === "task" ? (
                    <span
                      dir="auto"
                      className="flex-1 truncate text-left text-sm text-ink-dim"
                    >
                      {it.title}
                    </span>
                  ) : (
                    <button
                      type="button"
                      dir="auto"
                      onClick={() => setDetail(it)}
                      className="flex-1 truncate text-left text-sm text-ink-dim transition group-hover:text-ink"
                    >
                      {it.title}
                    </button>
                  )}
                  {it.meetingUrl && (
                    <a
                      href={it.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Join the call"
                      className="shrink-0 text-plasma/70 transition hover:text-plasma"
                    >
                      <Video className="size-3" />
                    </a>
                  )}
                  <span
                    className="font-mono text-[8px] uppercase tracking-widest opacity-60"
                    style={{ color: it.accent }}
                  >
                    {KIND_LABEL[it.kind]}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <EventDetail
        item={detail}
        onClose={() => setDetail(null)}
        deletePending={deletePending}
        onDelete={(id) =>
          startDelete(async () => {
            await deleteEvent(id);
            setDetail(null);
          })
        }
      />
    </div>
  );
}
