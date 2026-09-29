import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Work-item lifecycle (Plane's state groups, one state each):
 *   backlog → todo → doing → review → done   (+ cancelled, a closed dead end)
 * Text enum, no DB constraint — widening it needs no migration.
 */
export const TASK_STATUSES = ["backlog", "todo", "doing", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Still to do — everything the "open work" views, rollups and agents count. */
export const OPEN_STATUSES = ["backlog", "todo", "doing", "review"] as const satisfies readonly TaskStatus[];
/** Committed / in motion — what the day planner may pull into today. */
export const ACTIVE_STATUSES = ["todo", "doing", "review"] as const satisfies readonly TaskStatus[];
export const CLOSED_STATUSES = ["done", "cancelled"] as const satisfies readonly TaskStatus[];
export const isClosed = (s: TaskStatus) => s === "done" || s === "cancelled";

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    notes: text("notes"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("todo"),
    priority: text("priority", { enum: TASK_PRIORITIES })
      .notNull()
      .default("medium"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** When work is planned to start (the Timeline bar's left edge). */
    startAt: timestamp("start_at", { withTimezone: true }),
    /** Cross-module entity ref, e.g. "projects:<uuid>" — text, not FK, so modules stay droppable. */
    projectRef: text("project_ref"),
    /**
     * Optional "features:<uuid>" ref when this task is part of a multi-task
     * feature. featureRef set → task belongs to that feature (and still carries
     * the feature's projectRef so it rolls up to the project); null → a
     * standalone project/loose task.
     */
    featureRef: text("feature_ref"),
    /**
     * Per-scope sequence number — the N in the human identifier "KEY-N"
     * (project key, or "T" for unfiled work). Assigned from work_counters;
     * reassigned when an item moves to another project.
     */
    number: integer("number"),
    /** Parent work item (sub-items). Same table, no FK — deleting a parent orphans children to top level. */
    parentId: uuid("parent_id"),
    /** Size in points (1/2/3/5/8…). Null = unestimated. */
    estimate: integer("estimate"),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    /** Manual order inside a board column / list group (fractional, so a move writes one row). */
    sortOrder: doublePrecision("sort_order").notNull().default(0),
    /** Where an imported item came from, e.g. "plane:<uuid>" — makes re-import idempotent. */
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_project").on(t.projectRef),
    index("tasks_parent").on(t.parentId),
    index("tasks_feature").on(t.featureRef),
    uniqueIndex("tasks_external_ref").on(t.externalRef).where(sql`${t.externalRef} is not null`),
  ],
);

export type Task = typeof tasks.$inferSelect;

/** Sort helper: urgent → high → medium → low (text enum, so plain desc would be wrong). */
export const priorityRank = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

/** SQL predicate: the item is still open (not done / cancelled). */
export const taskIsOpen = sql`${tasks.status} not in ('done','cancelled')`;

/**
 * Atomic per-scope counters behind work-item numbers. scope = a project id, or
 * "loose" for unfiled items. One upsert per new item; never decremented, so a
 * deleted item's number is never reused (links in commits stay unambiguous).
 */
export const workCounters = pgTable("work_counters", {
  scope: text("scope").primaryKey(),
  value: integer("value").notNull().default(0),
});

export const TASK_ACTIVITY_KINDS = ["created", "changed", "comment"] as const;
export type TaskActivityKind = (typeof TASK_ACTIVITY_KINDS)[number];

/**
 * The item's history + discussion, one row per event. `actor` is "user",
 * "agent:<name>", or "system:<source>" — so an agent's edits are always
 * attributable. A "changed" row records one field's from → to (display text).
 */
export const taskActivity = pgTable(
  "task_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id").notNull(),
    actor: text("actor").notNull(),
    kind: text("kind", { enum: TASK_ACTIVITY_KINDS }).notNull(),
    field: text("field"),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    body: text("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_activity_task").on(t.taskId, t.createdAt)],
);

export type TaskActivity = typeof taskActivity.$inferSelect;
