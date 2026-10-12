"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { useNow } from "@/core/ui/useNow";
import { WEEKDAY_LABELS, daysIntoWeek } from "@/core/work-week";
import { updateTask } from "../actions";
import type { WorkItem } from "../core";
import { STATUS_META, displayTitle, plainTitle } from "../states";

const DAY = 86_400_000;
const CELL_CAP = 3;

const dayStart = (t: number | Date | string) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
// Re-anchored via dayStart so a day count crossing a DST change still lands on the intended day.
const noon = (day: number) => new Date(dayStart(day + 12 * 3_600_000) + 12 * 3_600_000);
const closed = (s: WorkItem["status"]) => s === "done" || s === "cancelled";

/** The day an item sits on: its due date, else its start date. */
const dayOf = (t: WorkItem) => (t.dueAt ? dayStart(t.dueAt) : t.startAt ? dayStart(t.startAt) : null);

type Placed = { t: WorkItem; flight: boolean };

/**
 * Work items on a month grid by due date (start date when there's no due).
 * An open item with a start date also shows, faded, on each day it is in
 * progress: start → the day before due, or start → today when it has no due.
 * Drag a chip (from any of its days) to another day to reschedule it — the
 * item shifts by that many days, so a start → due span keeps its length.
 */
export function CalendarView({ items, onOpen }: { items: WorkItem[]; onOpen: (id: string) => void }) {
  const router = useRouter();
  const now = useNow();
  const today = dayStart(now);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [, startSave] = useTransition();

  // Optimistic shift (ms) per item after a drop, cleared when the server sends fresh data.
  const [moved, setMoved] = useState<Record<string, number>>({});
  const [seed, setSeed] = useState(items);
  if (seed !== items) {
    setSeed(items);
    setMoved({});
  }

  const base = new Date(now);
  const month = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  // Grid starts on the work week's first day on/before the 1st; six weeks covers every month.
  const first = dayStart(month);
  const lead = daysIntoWeek(month);
  const gridStart = first - lead * DAY;
  const cells = Array.from({ length: 42 }, (_, i) => dayStart(gridStart + i * DAY + 12 * 3_600_000));

  const gridEnd = cells[cells.length - 1];
  const shift = (d: number, id: string) => dayStart(noon(d + (moved[id] ?? 0)));
  const byDay = new Map<number, Placed[]>();
  const put = (d: number, p: Placed) => byDay.set(d, [...(byDay.get(d) ?? []), p]);
  let undated = 0;
  for (const t of items) {
    const base = dayOf(t);
    if (base == null) {
      if (!closed(t.status)) undated++;
      continue;
    }
    const d = shift(base, t.id);
    put(d, { t, flight: false });
    if (closed(t.status) || !t.startAt) continue;
    // In progress: start → the day before due, or start → today when open-ended.
    const start = shift(dayStart(t.startAt), t.id);
    const end = t.dueAt ? d - 1 : Math.max(today, start);
    for (let c = Math.max(start, gridStart); c <= Math.min(end, gridEnd); c = dayStart(c + DAY + 12 * 3_600_000)) {
      if (c !== d) put(c, { t, flight: true });
    }
  }
  const dueKey = (t: WorkItem) => (t.dueAt ? +new Date(t.dueAt) : Infinity);
  for (const list of byDay.values())
    list.sort(
      (a, b) =>
        Number(a.flight) - Number(b.flight) ||
        Number(closed(a.t.status)) - Number(closed(b.t.status)) ||
        (a.flight ? dueKey(a.t) - dueKey(b.t) || 0 : 0) ||
        a.t.sortOrder - b.t.sortOrder,
    );

  const reschedule = (id: string, from: number, to: number) => {
    const t = items.find((x) => x.id === id);
    if (!t || from === to || dayOf(t) == null) return;
    const prev = moved[id] ?? 0;
    const delta = prev + (to - from);
    setMoved((p) => ({ ...p, [id]: delta }));
    const patch: { dueAt?: Date; startAt?: Date } = {};
    if (t.dueAt) patch.dueAt = noon(dayStart(t.dueAt) + delta);
    if (t.startAt) patch.startAt = noon(dayStart(t.startAt) + delta);
    startSave(async () => {
      const r = await act(() => updateTask(id, patch), { failed: "Couldn't reschedule the item" });
      if (!r.ok) setMoved((p) => ({ ...p, [id]: prev }));
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOffset(offset - 1)} aria-label="Previous month" className="rounded-lg p-1 text-ink-faint hover:bg-ink/5 hover:text-ink">
          <ChevronLeft className="size-4" />
        </button>
        <h3 className="min-w-36 text-center font-display text-sm text-ink">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </h3>
        <button type="button" onClick={() => setOffset(offset + 1)} aria-label="Next month" className="rounded-lg p-1 text-ink-faint hover:bg-ink/5 hover:text-ink">
          <ChevronRight className="size-4" />
        </button>
        {offset !== 0 && (
          <button type="button" onClick={() => setOffset(0)} className="rounded-lg px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint hover:bg-ink/5 hover:text-ink">
            today
          </button>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {undated > 0 ? `${undated} open without a date · ` : ""}drag an item to another day to reschedule
        </span>
      </div>

      <div className="glass overflow-x-auto rounded-xl">
        <div className="grid min-w-[720px] grid-cols-7">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="border-b border-ion/10 px-2 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
              {d}
            </div>
          ))}
          {cells.map((day) => {
            const list = byDay.get(day) ?? [];
            const inMonth = new Date(day).getMonth() === month.getMonth();
            const open = expanded === day;
            const shown = open ? list : list.slice(0, CELL_CAP);
            return (
              <div
                key={day}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (over !== day) setOver(day);
                }}
                onDragLeave={() => over === day && setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const [id, from] = e.dataTransfer.getData("text/x-work-item").split("@");
                  if (id && from) reschedule(id, Number(from), day);
                }}
                className={cn(
                  "flex min-h-24 flex-col gap-1 border-b border-r border-ion/8 p-1.5 transition-colors",
                  !inMonth && "bg-void/30",
                  over === day && "bg-ion/10",
                )}
              >
                <span
                  className={cn(
                    "self-end font-mono text-[11px] tabular-nums",
                    day === today ? "rounded bg-flare/80 px-1 text-void" : inMonth ? "text-ink-dim" : "text-ink-faint/50",
                  )}
                >
                  {new Date(day).getDate()}
                </span>
                {shown.map(({ t, flight }) => {
                  const late = !flight && !closed(t.status) && day < today && !!t.dueAt;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/x-work-item", `${t.id}@${day}`);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onOpen(t.id)}
                      title={`${t.identifier ?? ""} ${plainTitle(t.title)}${flight ? ` · in progress${t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}` : ""}`}
                      className={cn(
                        "flex items-center gap-1 truncate rounded-md border-l-2 bg-ink/[0.04] px-1.5 py-0.5 text-left text-[11px] text-ink-dim hover:bg-ink/[0.08] hover:text-ink",
                        closed(t.status) && "line-through opacity-50",
                        flight && "border-dashed bg-transparent opacity-60 hover:opacity-100",
                        late && "bg-flare/10",
                      )}
                      style={{ borderLeftColor: STATUS_META[t.status].color }}
                    >
                      <span dir="auto" className="truncate">{displayTitle(t)}</span>
                    </button>
                  );
                })}
                {list.length > CELL_CAP && (
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : day)}
                    className="self-start px-1 font-mono text-[11px] text-ink-faint hover:text-ink"
                  >
                    {open ? "less" : `+${list.length - CELL_CAP} more`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
