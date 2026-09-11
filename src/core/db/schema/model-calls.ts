import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A LIVE registry of in-flight model calls — the single chokepoint that makes
 * EVERY model invocation visible in the run queue, whatever its origin.
 *
 * A row exists only while a call is running: the provider-layer wrapper (see
 * core/ai/model-track) inserts one when any provider.run() starts and DELETES it
 * when the call ends; embeddings do the same around embedText. So this table is
 * always tiny — its size is the current concurrency, not history.
 *
 * The run queue reads it to surface calls that have no richer representation
 * (background jobs, gates, Ask, flows, sub-tasks, embeddings). Calls that ARE
 * already a queue row — an agent_run / chat_run / workbench task — carry
 * `parentKind` so the queue can suppress them and show the rich parent instead.
 *
 * Orphans (a row whose process died before the DELETE) are ignored by the queue
 * once older than a staleness cutoff and swept by a periodic job.
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** "generation" (a provider.run) or "embedding" (embedText). */
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Human label — agent name, chat title, job channel, "embedding", … */
    label: text("label").notNull().default(""),
    /** Origin class: agent | chat | workbench | knowledge | job | gate | ask |
     *  flow | subtask | embedding | test | unknown. */
    source: text("source").notNull().default("unknown"),
    /** When set to a queue-backed kind (agent/chat/workbench/knowledge), the
     *  queue suppresses this row in favor of the richer parent row. */
    parentKind: text("parent_kind"),
    parentId: text("parent_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("model_calls_started").on(t.startedAt)],
);

export type ModelCall = typeof modelCalls.$inferSelect;
