import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const EVENT_SOURCES = ["local", "ics", "google"] as const;

/** One attendee as captured from the Google API (L3 people derivation). */
export interface EventAttendee {
  email: string;
  name?: string;
  /** true for the calendar owner's own entry — excluded from the people table. */
  self?: boolean;
  responseStatus?: string;
}

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    notes: text("notes"),
    location: text("location"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    allDay: boolean("all_day").notNull().default(false),
    source: text("source", { enum: EVENT_SOURCES }).notNull().default("local"),
    /** Stable UID from the ICS feed / Google API — sync upserts on this. */
    icsUid: text("ics_uid"),
    /** The event's own color (hex) — from the Google API; null = category default. */
    color: text("color"),
    /** Video-call URL (Meet/Zoom/Teams) — Google `hangoutLink`/`conferenceData`,
     *  or the ICS `X-GOOGLE-CONFERENCE` property. Powers the JOIN button. */
    meetingUrl: text("meeting_url"),
    /** The event in its origin app (Google `htmlLink`) — "open in Google Calendar". */
    sourceUrl: text("source_url"),
    /** Attendees from the Google API — feeds the L3 people table. */
    attendees: jsonb("attendees").$type<EventAttendee[]>(),
    /** The Google calendar the event came from (null = ICS / local / pre-multi-calendar rows). */
    calendarId: text("calendar_id"),
    /** Google "Show as: Free" — the event doesn't block time when planning. */
    transparent: boolean("transparent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("calendar_events_start").on(t.startAt),
    uniqueIndex("calendar_events_ics_uid").on(t.icsUid),
  ],
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
