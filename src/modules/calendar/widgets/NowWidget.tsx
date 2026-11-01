import { and, count, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/core/db/client";
import { identifierOf, projectKeyMap } from "@/modules/tasks/core";
import { ACTIVE_STATUSES, tasks } from "@/modules/tasks/schema";
import { boxesOn, dayRange, localDate } from "@/modules/today/plan";
import { KIND_META } from "@/modules/today/timebox-kinds";
import { getTimeboxSettings } from "@/modules/today/timebox-settings";
import { getAgenda } from "../agenda";
import { NowStrip, type NowItem } from "../components/NowStrip";

/** Today's Now strip: the box (or call) you're in, what's next, and the day as a ribbon. */
export async function NowWidget() {
  const now = new Date();
  const today = dayRange(now);
  const tomorrow = dayRange(today.end);
  const [settings, boxes, tomorrowBoxes, agenda, [{ due }]] = await Promise.all([
    getTimeboxSettings(),
    boxesOn(now),
    boxesOn(tomorrow.start),
    getAgenda(today.start, tomorrow.end),
    db
      .select({ due: count() })
      .from(tasks)
      .where(and(inArray(tasks.status, [...ACTIVE_STATUSES]), gte(tasks.dueAt, today.start), lt(tasks.dueAt, today.end))),
  ]);

  // "open ETHOS-12" on the box you're in.
  const taskIds = [...new Set(boxes.flatMap((b) => (b.taskId ? [b.taskId] : [])))];
  const refs = new Map<string, string | null>();
  if (taskIds.length) {
    const [rows, keys] = await Promise.all([
      db.select({ id: tasks.id, projectRef: tasks.projectRef, number: tasks.number }).from(tasks).where(inArray(tasks.id, taskIds)),
      projectKeyMap(db),
    ]);
    for (const t of rows) refs.set(t.id, identifierOf(t, keys));
  }

  // Calls that hold the time; free and declined ones don't shape the day.
  const meetings = agenda.filter((e) => e.kind === "event" && e.busy && !e.allDay);
  const items: NowItem[] = [
    ...boxes
      .filter((b) => b.status === "planned" || b.status === "done")
      .map((b) => ({
        id: b.id,
        kind: "box" as const,
        title: b.title,
        start: b.startAt.getTime(),
        end: b.endAt.getTime(),
        color: KIND_META[b.kind].color,
        label: KIND_META[b.kind].label.toLowerCase(),
        endMode: b.endMode,
        done: b.status === "done",
        meetingUrl: null,
        href: b.taskId ? `/m/tasks/${b.taskId}` : null,
        ref: b.taskId ? (refs.get(b.taskId) ?? null) : null,
      })),
    ...meetings
      .filter((e) => e.at < today.end)
      .map((e) => ({
        id: e.id,
        kind: "event" as const,
        title: e.title,
        start: e.at.getTime(),
        end: (e.endAt ?? new Date(e.at.getTime() + 30 * 60_000)).getTime(),
        color: "var(--color-ink-faint)",
        label: "meeting",
        endMode: null,
        done: false,
        meetingUrl: e.meetingUrl,
        href: e.sourceUrl,
        ref: null,
      })),
  ].sort((a, b) => a.start - b.start);

  const next = meetings.filter((e) => e.at >= tomorrow.start);
  return (
    <NowStrip
      serverNow={now.getTime()}
      settings={settings}
      items={items}
      drafts={boxes.filter((b) => b.status === "draft").length}
      dueToday={due}
      tomorrow={{
        date: localDate(tomorrow.start),
        meetings: next.length,
        firstAt: next[0]?.at.getTime() ?? null,
        boxed: tomorrowBoxes.filter((b) => b.status === "planned").length,
      }}
    />
  );
}
