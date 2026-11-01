"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Video } from "lucide-react";
import { act } from "@/core/ui/feedback";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { dur, HATCH, hhmm, pad, tint } from "@/modules/today/components/DayTimeline";
import { atTime, capacity, workWindow } from "@/modules/today/draft-day";
import { updateBox } from "@/modules/today/timebox-actions";
import type { TimeboxSettings } from "@/modules/today/timebox-settings";

/** A planned box or a call that holds the time, today. Times are epoch ms. */
export interface NowItem {
  id: string;
  kind: "box" | "event";
  title: string;
  start: number;
  end: number;
  color: string;
  /** "deep", "shallow"… or "meeting". */
  label: string;
  endMode: "soft" | "hard" | null;
  done: boolean;
  meetingUrl: string | null;
  /** The box's work item, or the event in Google. */
  href: string | null;
  /** "ETHOS-12" for a box on a work item. */
  ref: string | null;
}

const MIN = 60_000;

/** "34:12", or "1:04:12" past the hour. */
function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const inMin = (ms: number) => (ms < 60 * MIN ? `in ${Math.max(1, Math.round(ms / MIN))}m` : `in ${dur(Math.round(ms / MIN))}`);

const BTN =
  "whitespace-nowrap rounded-lg border border-white/12 px-3 py-1.5 text-xs text-ink-dim transition hover:border-white/25 hover:text-ink disabled:opacity-50";
const BTN_PRI =
  "whitespace-nowrap rounded-lg border border-plasma bg-plasma px-3 py-1.5 text-xs font-medium text-void transition hover:brightness-110";
const LBL = "font-mono text-[10px] uppercase tracking-[0.3em]";

function Join({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="Join the call"
      className="flex shrink-0 items-center gap-1 rounded-md border border-plasma/30 bg-plasma/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-plasma transition hover:bg-plasma/20"
    >
      <Video className="size-3" />
      join
    </a>
  );
}

export function NowStrip({
  serverNow,
  settings,
  items,
  drafts,
  dueToday,
  tomorrow,
}: {
  serverNow: number;
  settings: TimeboxSettings;
  items: NowItem[];
  drafts: number;
  dueToday: number;
  tomorrow: { date: string; meetings: number; firstAt: number | null; boxed: number };
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  // Starts at the server's clock so the first paint hydrates cleanly, then ticks.
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useLiveEvents(["calendar_changed"]);

  const day = new Date(now);
  const dayStart = atTime(day, settings.start).getTime();
  const shutdown = atTime(day, settings.workEnd).getTime();
  const boxDay = settings.days.includes(day.getDay());
  const boxes = items.filter((i) => i.kind === "box");
  const live = (i: NowItem) => !i.done && i.start <= now && now < i.end;
  // The box you're in; failing that, the call you're on.
  const cur = items.find((i) => i.kind === "box" && live(i)) ?? items.find((i) => i.kind === "event" && live(i)) ?? null;
  const ahead = items.filter((i) => i !== cur && !i.done && i.end > now);

  const run = (fn: () => Promise<unknown>, failed: string) =>
    start(async () => {
      const r = await act(fn, { failed });
      if (r.ok) router.refresh();
    });

  let main: React.ReactNode;
  if (cur) {
    const total = cur.end - cur.start;
    const pct = Math.min(100, ((now - cur.start) / total) * 100);
    main = (
      <div
        data-testid="now-current"
        className="px-5 pt-4 pb-3.5"
        style={{
          borderLeft: `3px solid ${cur.color}`,
          background: cur.kind === "box" ? `linear-gradient(100deg, color-mix(in oklab, ${cur.color} 14%, transparent), transparent 70%)` : undefined,
        }}
      >
        <p className={cn(LBL, "flex items-center gap-2")} style={{ color: cur.kind === "box" ? cur.color : "var(--color-ink-dim)" }}>
          <span className="size-[7px] rounded-full" style={{ background: cur.color, boxShadow: `0 0 8px ${cur.color}` }} />
          now · {cur.label}
          {cur.endMode && ` · ${cur.endMode} end`}
        </p>
        <h2 dir="auto" className="mt-1.5 mb-0.5 truncate font-display text-[21px] font-semibold text-ink">
          {cur.title}
        </h2>
        <p className="flex items-center gap-2 font-mono text-[11px] text-ink-dim">
          {hhmm(cur.start)} → {hhmm(cur.end)}
          {cur.ref && cur.href && (
            <>
              {" · "}
              <Link href={cur.href} className="inline-flex items-center gap-0.5 text-plasma hover:underline">
                open {cur.ref}
                <ArrowUpRight className="size-3" />
              </Link>
            </>
          )}
          {cur.meetingUrl && <Join url={cur.meetingUrl} />}
        </p>
        <div className="mt-3 flex items-center gap-4">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/7">
            <i className="block h-full" style={{ width: `${pct}%`, background: cur.color }} />
          </div>
          <span data-testid="now-left" className="font-mono text-[26px] font-medium tracking-tight text-ink tabular-nums">
            {left(cur.end - now)}
            <small className="ml-1 text-[11px] tracking-normal text-ink-faint">left</small>
          </span>
          {cur.kind === "box" && (
            <button
              type="button"
              disabled={busy}
              className={BTN}
              onClick={() => run(() => updateBox(cur.id, { endAt: new Date() }), "Couldn't end the box")}
            >
              Finish early
            </button>
          )}
        </div>
      </div>
    );
  } else if (!boxDay || now >= shutdown) {
    const done = boxes.filter((b) => b.done).length;
    main = (
      <State
        tone="var(--color-solar)"
        label={boxDay ? `after shutdown · ${settings.workEnd}` : "no boxes today"}
        title={
          boxes.length === 0
            ? boxDay
              ? "Work day over"
              : "Not a box day"
            : `Day done — ${done ? `${done} of ${boxes.length}` : boxes.length} ${boxes.length === 1 ? "box" : "boxes"}${done ? " done" : ""}`
        }
        line={`Tomorrow: ${tomorrow.meetings} ${tomorrow.meetings === 1 ? "meeting" : "meetings"}${
          tomorrow.firstAt ? `, first at ${hhmm(tomorrow.firstAt)}` : ""
        } · ${tomorrow.boxed ? `${tomorrow.boxed} boxed` : "nothing boxed"}`}
      >
        <Link href={`/m/today/plan/${tomorrow.date}`} className={BTN_PRI}>
          Plan tomorrow →
        </Link>
      </State>
    );
  } else if (boxes.length === 0) {
    const window = workWindow(day, day, settings);
    const busyToday = items.filter((i) => i.kind === "event").map((i) => ({ start: new Date(i.start), end: new Date(i.end) }));
    const { free } = capacity(window, busyToday, []);
    const meetings = ahead.filter((i) => i.kind === "event").length;
    main = (
      <State
        tone="var(--color-plasma)"
        label={now < dayStart ? "morning · no plan yet" : "no plan yet"}
        title={free ? `${dur(free)} free before ${settings.workEnd}` : `No free time before ${settings.workEnd}`}
        line={`${meetings} ${meetings === 1 ? "meeting" : "meetings"} · ${dueToday} due today · ${
          drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"} not locked` : "nothing boxed"
        }`}
      >
        <Link href="/m/today/plan" className={BTN_PRI}>
          Plan the day →
        </Link>
      </State>
    );
  } else {
    // Between boxes: free until whatever comes next, or the shutdown.
    const first = ahead.find((i) => i.start > now);
    const until = Math.min(first?.start ?? shutdown, shutdown);
    const nextBox = ahead.find((i) => i.kind === "box" && i.start > now);
    // Pulling the next box forward is only safe when nothing sits in between.
    const canStart = !!nextBox && nextBox === first;
    main = (
      <State
        tone="var(--color-ink-faint)"
        label="between boxes"
        title={until >= shutdown ? `Free until shutdown · ${settings.workEnd}` : `Free until ${hhmm(until)}`}
        line={`${dur(Math.round((until - now) / MIN))} unboxed · next: ${nextBox?.title ?? "nothing boxed"}`}
      >
        {canStart && (
          <button
            type="button"
            disabled={busy}
            className={BTN}
            onClick={() => {
              const at = Math.floor(now / MIN) * MIN;
              run(
                () => updateBox(nextBox.id, { startAt: new Date(at), endAt: new Date(at + nextBox.end - nextBox.start) }),
                "Couldn't move the box",
              );
            }}
          >
            Start it now
          </button>
        )}
        <Link href="/m/today/plan" className={BTN}>
          Box something
        </Link>
      </State>
    );
  }

  const boxesLeft = ahead.filter((i) => i.kind === "box").length + (cur?.kind === "box" ? 1 : 0);
  const meetingsLeft = ahead.filter((i) => i.kind === "event").length + (cur?.kind === "event" ? 1 : 0);

  return (
    <div data-testid="now-strip" className="glass relative overflow-hidden rounded-(--radius-panel)">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        {main}
        <div className="border-t border-white/6 px-4.5 py-4 lg:border-t-0 lg:border-l">
          <p className={cn(LBL, "mb-2.5 text-ink-faint")}>next</p>
          {ahead.length === 0 ? (
            <p className="text-[13px] text-ink-faint">nothing else today</p>
          ) : (
            <ul data-testid="now-next">
              {ahead.slice(0, 3).map((i, n) => (
                <li key={i.id} className="flex items-center gap-2.5 py-1 text-[13px] text-ink-dim" title={`${i.title} · ${hhmm(i.start)}–${hhmm(i.end)}`}>
                  <span className="h-4 w-[3px] shrink-0 rounded-sm" style={{ background: i.color }} />
                  <span className="w-10 shrink-0 font-mono text-[11px] text-ink-faint">{hhmm(i.start)}</span>
                  <span dir="auto" className={cn("min-w-0 flex-1 truncate", n === 0 && "text-ink")}>
                    {i.title}
                  </span>
                  {n === 0 && (
                    <span className="shrink-0 font-mono text-[10px] text-solar">{i.start <= now ? "now" : inMin(i.start - now)}</span>
                  )}
                  {i.meetingUrl && <Join url={i.meetingUrl} />}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
            <span className="flex-1">
              {boxesLeft} {boxesLeft === 1 ? "box" : "boxes"} · {meetingsLeft} {meetingsLeft === 1 ? "meeting" : "meetings"} left
            </span>
            <Link href="/m/today/plan" className="text-plasma hover:underline">
              plan →
            </Link>
          </div>
        </div>
      </div>
      {boxDay && <Ribbon items={items} from={dayStart} to={shutdown} now={now} />}
    </div>
  );
}

function State({
  tone,
  label,
  title,
  line,
  children,
}: {
  tone: string;
  label: string;
  title: string;
  line: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid="now-state" className="px-5 pt-4 pb-3.5" style={{ borderLeft: `3px solid ${tone}` }}>
      <p className={cn(LBL, "mb-1.5")} style={{ color: tone === "var(--color-solar)" ? tone : "var(--color-ink-faint)" }}>
        {label}
      </p>
      <h2 className="mb-1 font-display text-[19px] font-semibold text-ink">{title}</h2>
      <p dir="auto" className="mb-3 truncate font-mono text-[11px] text-ink-dim">
        {line}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** The work day as a thin bar: boxes tinted by kind, calls hatched, a red now-line, the shutdown dashed. */
function Ribbon({ items, from, to, now }: { items: NowItem[]; from: number; to: number; now: number }) {
  if (to <= from) return null;
  const pct = (t: number) => `${(Math.min(Math.max(t, from), to) - from) / (to - from) * 100}%`;
  const hours: number[] = [];
  for (let t = Math.ceil(from / (60 * MIN)) * 60 * MIN; t <= to; t += 60 * MIN) hours.push(t);
  return (
    <div data-testid="now-ribbon" className="relative mx-5 mb-3 h-11">
      <div className="absolute inset-x-0 top-2 h-5 rounded-[5px] bg-white/[0.035]" />
      {items
        .filter((i) => i.end > from && i.start < to)
        .map((i) => (
          <div
            key={i.id}
            title={`${i.title} · ${hhmm(i.start)}–${hhmm(i.end)}`}
            className={cn("absolute top-2 h-5 rounded", i.done && "opacity-45")}
            style={{
              left: pct(i.start),
              width: `calc(${pct(i.end)} - ${pct(i.start)})`,
              borderLeft: `2px solid ${i.color}`,
              background: i.kind === "box" ? tint(i.color, 30) : HATCH,
            }}
          />
        ))}
      {now > from && <div className="absolute left-0 top-2 h-5 rounded-l-[5px] bg-void/45" style={{ width: pct(now) }} />}
      {now >= from && now <= to && (
        <div className="absolute top-0.5 h-8 border-l-2 border-flare" style={{ left: pct(now) }}>
          <span className="absolute -top-[3px] -left-[5px] size-2 rounded-full bg-flare" />
        </div>
      )}
      <div className="absolute top-1 right-0 h-7 border-l-2 border-dashed border-solar/70" />
      {hours.map((t) => (
        <span key={t} className="absolute top-[31px] -translate-x-1/2 font-mono text-[9px] text-ink-faint" style={{ left: pct(t) }}>
          {pad(new Date(t).getHours())}
        </span>
      ))}
    </div>
  );
}
