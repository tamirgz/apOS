import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { RUN_STATUSES } from "./agents";

/**
 * A user-initiated chat prompt, run as a PERSISTENT job (not a browser-tied
 * stream). Created by /api/chat when a prompt is sent; the pipeline then runs
 * detached from the client connection, so navigating away doesn't abort it and
 * the answer is here when the user returns. Surfaced in the same Run queue as
 * agent_runs (externally-initiated work, vs agents' internally-initiated work).
 */
export const chatRuns = pgTable(
  "chat_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The route/brain that answered: "chat" (⌘K), "chat.investments", "ask". */
    taskKey: text("task_key").notNull(),
    /** A short human label (the prompt's first line) for the queue/history. */
    title: text("title").notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("running"),
    /** The full conversation sent (so the run is self-contained / re-showable). */
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    /** Resolved provider/model that actually ran (for the queue + audit). */
    provider: text("provider"),
    model: text("model"),
    /** Streaming transcript (same AIEvent shape the chat renders). */
    transcript: jsonb("transcript").$type<unknown[]>().notNull().default([]),
    /** Final answer text. */
    result: text("result"),
    error: text("error"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_runs_created").on(t.createdAt)],
);

export type ChatRun = typeof chatRuns.$inferSelect;
