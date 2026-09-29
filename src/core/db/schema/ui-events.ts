import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Local-only UI usage telemetry — which pages you open and which key actions
 * you take. It exists so "which features do I actually use?" is answered from
 * data instead of reconstructed from write traces. Nothing leaves the database;
 * rows older than 90 days are dropped by the nightly retention sweep.
 *
 *   event = "view"  → path is the page (one row per client-side navigation)
 *   event = "<module>.<action>" (e.g. "work.create", "attention.dismiss")
 */
export const uiEvents = pgTable(
  "ui_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    event: text("event").notNull(),
    path: text("path"),
    /** Optional cross-module ref the action touched, e.g. "tasks:<uuid>". */
    entityRef: text("entity_ref"),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => [index("ui_events_ts").on(t.ts), index("ui_events_event_ts").on(t.event, t.ts)],
);

export type UiEvent = typeof uiEvents.$inferSelect;
