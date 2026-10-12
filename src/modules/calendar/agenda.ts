import { and, asc, gte, lte } from "drizzle-orm";
import { db } from "@/core/db/client";
import { calendarEvents } from "./schema";

export interface AgendaItem {
  id: string;
  kind: "event";
  title: string;
  at: Date;
  endAt: Date | null;
  allDay: boolean;
  detail: string | null;
  href: string;
  accent: string;
  /** Only apOS-local events may be deleted from apOS. */
  deletable: boolean;
  /** Detail-panel fields. */
  location: string | null;
  notes: string | null;
  /** Video-call URL, when the event has one — drives the JOIN button. */
  meetingUrl: string | null;
  /** The event in its origin app (Google Calendar). */
  sourceUrl: string | null;
  source: string;
}

/**
 * The user's personal agenda: calendar events only — apOS-local events plus
 * those synced from connected calendars (Google/ICS). Work items never appear
 * here; project dates live on the project's own Work calendar.
 */
export async function getAgenda(from: Date, to: Date): Promise<AgendaItem[]> {
  const events = await db
    .select()
    .from(calendarEvents)
    .where(and(gte(calendarEvents.startAt, from), lte(calendarEvents.startAt, to)))
    .orderBy(asc(calendarEvents.startAt));

  return events.map((e) => ({
    id: e.id,
    kind: "event" as const,
    title: e.title,
    at: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay,
    detail: e.location ?? (e.source !== "local" ? "google" : null),
    href: "/m/calendar",
    // The event's own Google color wins; category color is the fallback.
    accent: e.color ?? (e.source !== "local" ? "var(--color-ion)" : "var(--color-plasma)"),
    deletable: e.source === "local",
    location: e.location,
    notes: e.notes,
    meetingUrl: e.meetingUrl,
    sourceUrl: e.sourceUrl,
    source: e.source,
  }));
}
