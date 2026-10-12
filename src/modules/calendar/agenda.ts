import { and, asc, gte, isNotNull, lte } from "drizzle-orm";
import { db } from "@/core/db/client";
import { taskIsOpen, tasks } from "../tasks/schema";
import { calendarEvents } from "./schema";
import { displayTitle } from "../tasks/states";

export interface AgendaItem {
  id: string;
  kind: "event" | "task";
  title: string;
  at: Date;
  endAt: Date | null;
  allDay: boolean;
  detail: string | null;
  href: string;
  accent: string;
  /** Only apOS-local events may be deleted from apOS. */
  deletable: boolean;
  /** Detail-panel fields — null for task rows. */
  location: string | null;
  notes: string | null;
  /** Video-call URL, when the event has one — drives the JOIN button. */
  meetingUrl: string | null;
  /** The event in its origin app (Google Calendar). */
  sourceUrl: string | null;
  source: string;
}

/**
 * The unified agenda: calendar events (local + Google/ICS) merged with task
 * due dates and content publish dates — the cross-module view that makes the
 * calendar useful even before any events exist.
 */
export async function getAgenda(from: Date, to: Date): Promise<AgendaItem[]> {
  const [events, dueTasks] = await Promise.all([
    db
      .select()
      .from(calendarEvents)
      .where(
        and(gte(calendarEvents.startAt, from), lte(calendarEvents.startAt, to)),
      )
      .orderBy(asc(calendarEvents.startAt)),
    db
      .select()
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.dueAt),
          gte(tasks.dueAt, from),
          lte(tasks.dueAt, to),
          taskIsOpen,
        ),
      ),
  ]);

  const items: AgendaItem[] = [
    ...events.map((e) => ({
      id: e.id,
      kind: "event" as const,
      title: e.title,
      at: e.startAt,
      endAt: e.endAt,
      allDay: e.allDay,
      detail: e.location ?? (e.source !== "local" ? "google" : null),
      href: "/m/calendar",
      // The event's own Google color wins; category color is the fallback.
      accent:
        e.color ??
        (e.source !== "local" ? "var(--color-ion)" : "var(--color-plasma)"),
      deletable: e.source === "local",
      location: e.location,
      notes: e.notes,
      meetingUrl: e.meetingUrl,
      sourceUrl: e.sourceUrl,
      source: e.source,
    })),
    ...dueTasks.map((t) => ({
      id: t.id,
      kind: "task" as const,
      title: displayTitle(t),
      at: t.dueAt!,
      endAt: null,
      allDay: false,
      detail: `${t.priority} priority`,
      href: `/m/tasks/${t.id}`,
      accent: "var(--color-solar)",
      deletable: false,
      location: null,
      notes: t.notes,
      meetingUrl: null,
      sourceUrl: null,
      source: "task",
    })),
  ];

  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}
