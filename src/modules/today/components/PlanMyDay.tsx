"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CalendarClock, CalendarPlus, Sparkles, Video } from "lucide-react";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import type { AgendaItem } from "@/modules/calendar/agenda";
import { scheduleBlock } from "../actions";
import type { PlanBlock } from "../queries";

const fmtTime = (d: Date) =>
  new Date(d).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** Next round hour from now, so a scheduled block lands somewhere sensible. */
function nextHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function ScheduleButton({
  title,
  onDone,
}: {
  title: string;
  onDone?: () => void;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      title="Add a 1-hour block to today's calendar"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await scheduleBlock({ title, startAt: nextHour(), minutes: 60 });
          onDone?.();
        })
      }
      className="flex shrink-0 items-center gap-1 rounded-md border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:border-solar/30 hover:text-solar disabled:opacity-40"
    >
      <CalendarPlus className="size-3" />
      block
    </button>
  );
}

export function PlanMyDay({
  agenda,
  suggestions,
}: {
  agenda: AgendaItem[];
  suggestions: PlanBlock[];
}) {
  useLiveEvents(["calendar_changed", "attention_changed"]);
  const [scheduled, setScheduled] = useState<Set<string>>(new Set());

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <section>
      <div className="mb-2.5 flex items-baseline gap-2 px-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-solar">
          plan my day
        </p>
        <span className="font-mono text-[10px] text-ink-faint">{today}</span>
      </div>

      {/* Today's timeline: meetings + due tasks. */}
      <div className="glass rounded-2xl p-4">
        <div className="mb-2 flex items-center gap-2">
          <CalendarClock className="size-3.5 text-ink-faint" />
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            on the calendar
          </p>
        </div>
        {agenda.length === 0 ? (
          <p className="py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            clear
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {agenda.map((it) => (
              <div
                key={`${it.kind}:${it.id}`}
                className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/4"
              >
                <span className="dot shrink-0" style={{ color: it.accent }} />
                <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-faint">
                  {it.allDay ? "all day" : fmtTime(it.at)}
                </span>
                <Link
                  href={it.href}
                  dir="auto"
                  className="flex-1 truncate text-left text-sm text-ink-dim transition group-hover:text-ink"
                >
                  {it.title}
                </Link>
                {it.meetingUrl && (
                  <a
                    href={it.meetingUrl}
                    target="_blank"
                    rel="noreferrer"
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
                  {it.kind === "task" ? "due" : "event"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suggested focus: each active project's next-action. */}
      {suggestions.length > 0 && (
        <div className="glass mt-3 rounded-2xl p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="size-3.5 text-solar" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              move a project forward
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            {suggestions
              .filter((s) => !scheduled.has(s.id))
              .map((s) => (
                <div
                  key={s.id}
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/4"
                >
                  <span className="dot shrink-0 text-solar" />
                  {s.href ? (
                    <Link
                      href={s.href}
                      className="flex-1 truncate text-left text-sm text-ink-dim transition group-hover:text-ink"
                    >
                      {s.title}
                    </Link>
                  ) : (
                    <span className="flex-1 truncate text-left text-sm text-ink-dim">
                      {s.title}
                    </span>
                  )}
                  <ScheduleButton
                    title={s.title}
                    onDone={() => setScheduled((p) => new Set(p).add(s.id))}
                  />
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
