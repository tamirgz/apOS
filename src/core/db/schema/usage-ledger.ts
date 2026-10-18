import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One row per finished model generation: who ran it, on what, how many tokens,
 * and what it cost. Unlike model_calls (live, deleted when a call ends) this is
 * history — Settings › Usage sums it into 30-day cost per provider and agent.
 *
 * Written by the provider chokepoint (core/ai/model-track) from the call's
 * usage events, so every routed call lands here whatever its origin. No FKs:
 * a ledger row outlives the agent or chat run it names.
 */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Origin class, as on model_calls: agent | chat | workbench | job | gate | … */
    source: text("source").notNull().default("unknown"),
    label: text("label").notNull().default(""),
    /** The AI route the call ran under, when the caller knows it (chat). */
    taskKey: text("task_key"),
    agentId: uuid("agent_id"),
    /** The run the call belongs to: agent → agent_runs.id, chat → chat_runs.id,
     *  workbench → task_attempts.id. */
    parentKind: text("parent_kind"),
    parentId: text("parent_id"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /** USD from the price table (core/ai/prices). 0 for local, `:free` and
     *  flat-rate providers; null when the model is metered but its price is
     *  unknown — shown as "?" rather than guessed. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
  },
  (t) => [index("usage_ledger_ts").on(t.ts)],
);

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
