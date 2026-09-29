import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The attention item — the single atom of the Life-OS loop (ONE-STOP §3.2).
 *
 * Everything a chief-of-staff agent surfaces is one of these: a typed,
 * project-anchored thing that wants the user's attention. The "Needs you"
 * queue and Plan-my-day are just different filters over these rows (plus the
 * pre-existing approvals + Workbench needs_input, which the queue aggregates
 * — we do NOT duplicate those here).
 */
export const ATTENTION_TYPES = [
  "notify", // FYI, no action needed
  "question", // needs a decision
  "review", // check my work / a draft
  "approve", // sign off before an action happens
  "do", // a suggested next action you can accept into the day
] as const;
export type AttentionType = (typeof ATTENTION_TYPES)[number];

export const ATTENTION_STATUSES = [
  "open",
  "snoozed",
  "done",
  "dismissed",
  // An agent-raised card nobody acted on within its TTL (see
  // expireStaleAgentCards) — kept apart from a user 'dismissed' for telemetry.
  "expired",
] as const;
export type AttentionStatus = (typeof ATTENTION_STATUSES)[number];

export const attentionItems = pgTable(
  "attention_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type", { enum: ATTENTION_TYPES }).notNull().default("notify"),
    title: text("title").notNull(),
    /** Why it surfaced — one or two sentences. */
    body: text("body"),
    /** Anchored to a project ("projects:<uuid>") or null = personal. */
    projectRef: text("project_ref"),
    /** Anchored to a person ("people:<uuid>") — L3 follow-ups. */
    personRef: text("person_ref"),
    /** Who raised it: "agent:Daily planner", "system", "connector"… */
    source: text("source").notNull().default("system"),
    status: text("status", { enum: ATTENTION_STATUSES })
      .notNull()
      .default("open"),
    /** Higher = more urgent. Drives queue sort and day-slotting. */
    urgency: integer("urgency").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /** Optional in-app link (a task, project, idea, workbench task…). */
    href: text("href"),
    /**
     * Type-specific extras: a proposed next-action string, a draft reply, a
     * diff ref — whatever the acting surface needs. Never a secret.
     */
    payload: jsonb("payload").notNull().default({}),
    /** Idempotency key so an agent re-run doesn't raise the same card twice. */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("attention_status").on(t.status, t.urgency),
    index("attention_project").on(t.projectRef),
    index("attention_person").on(t.personRef),
    // DB-level idempotency guard: at most one OPEN card per dedupe key, so a
    // re-running agent can never stack a duplicate nudge (mirrors the
    // agent_ledger / agent_runs_one_live partial-unique convention). NULL keys
    // are exempt, but insertAttentionItem always derives one.
    uniqueIndex("attention_dedupe_open")
      .on(t.dedupeKey)
      .where(sql`${t.status} = 'open' and ${t.dedupeKey} is not null`),
  ],
);

export type AttentionItem = typeof attentionItems.$inferSelect;
