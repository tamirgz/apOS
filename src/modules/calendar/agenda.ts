import { and, asc, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/core/db/client";
import { timeboxes, type TimeboxKind } from "@/modules/today/schema";
import { KIND_META } from "@/modules/today/timebox-kinds";
import { calendarEvents } from "./schema";

export interface AgendaItem {
  id: string;
  /** A calendar event, or one of the user's planned timeboxes. */
  kind: "event" | "timebox";
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
  /** The event holds the time: not marked "free", not declined. Boxes never count as busy. */
  busy: boolean;
  /** Timebox fields — null for events. */
  box: { kind: TimeboxKind; endMode: "soft" | "hard"; done: boolean } | null;
}

/**
 * The user's personal agenda: calendar events — apOS-local events plus those
 * synced from connected calendars (Google/ICS) — and the timeboxes the user
 * planned (drafts stay on the Plan screen). Work items never appear here;
 * project dates live on the project's own Work calendar.
 */
export async function getAgenda(from: Date, to: Date): Promise<AgendaItem[]> {
  const [events, boxes] = await Promise.all([
    db
      .select()
      .from(calendarEvents)
      .where(and(gte(calendarEvents.startAt, from), lte(calendarEvents.startAt, to)))
      .orderBy(asc(calendarEvents.startAt)),
    db
      .select()
      .from(timeboxes)
      .where(and(gte(timeboxes.startAt, from), lte(timeboxes.startAt, to), inArray(timeboxes.status, ["planned", "done"])))
      .orderBy(asc(timeboxes.startAt)),
  ]);

  const boxItems: AgendaItem[] = boxes.map((b) => ({
    id: b.id,
    kind: "timebox",
    title: b.title,
    at: b.startAt,
    endAt: b.endAt,
    allDay: false,
    detail: `timebox · ${KIND_META[b.kind].label.toLowerCase()}`,
    href: `/m/today/plan/${localDate(b.startAt)}`,
    accent: KIND_META[b.kind].color,
    deletable: false,
    location: null,
    notes: null,
    meetingUrl: null,
    sourceUrl: null,
    source: "timebox",
    busy: false,
    box: { kind: b.kind, endMode: b.endMode, done: b.status === "done" },
  }));

  const eventItems: AgendaItem[] = events.map((e) => ({
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
    busy: !e.transparent && !(e.attendees ?? []).some((a) => a.self && a.responseStatus === "declined"),
    box: null,
  }));
  return [...eventItems, ...boxItems].sort((a, b) => a.at.getTime() - b.at.getTime());
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
