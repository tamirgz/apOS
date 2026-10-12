import { and, asc, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
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
  /**
   * Open tasks only, with `inFlight`: the days the task is open — from its
   * start date to its due date (or to today when it has no due date). The
   * calendar lists it on each of those days, not just on the due date.
   */
  span: { start: Date; due: Date | null } | null;
}

/**
 * The unified agenda: calendar events (local + Google/ICS) merged with task
 * due dates and content publish dates — the cross-module view that makes the
 * calendar useful even before any events exist.
 */
export async function getAgenda(
  from: Date,
  to: Date,
  opts: { inFlight?: boolean } = {},
): Promise<AgendaItem[]> {
  // Due in the window — plus, with inFlight, open tasks whose start→due span
  // overlaps it (a task started today and due tomorrow belongs on today too).
  const dueInWindow = and(isNotNull(tasks.dueAt), gte(tasks.dueAt, from), lte(tasks.dueAt, to));
  const spansWindow = and(
    isNotNull(tasks.startAt),
    lte(tasks.startAt, to),
    or(isNull(tasks.dueAt), gte(tasks.dueAt, from)),
  );
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
      .where(and(opts.inFlight ? or(dueInWindow, spansWindow) : dueInWindow, taskIsOpen)),
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
      span: null,
    })),
    ...dueTasks.map((t) => ({
      id: t.id,
      kind: "task" as const,
      title: displayTitle(t),
      // Placed on its due date; a start-only task on its start date.
      at: (t.dueAt ?? t.startAt)!,
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
      span: opts.inFlight && t.startAt ? { start: t.startAt, due: t.dueAt } : null,
    })),
  ];

  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}
