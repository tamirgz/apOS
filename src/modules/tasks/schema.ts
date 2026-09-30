import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  boolean,
  jsonb,
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
    /** A short display title for list views, made by a local model from `title`
     *  (which is never rewritten). Valid only while `shortTitleOf` equals
     *  `titleHash(title)` — an edited title falls back to the original. */
    shortTitle: text("short_title"),
    shortTitleOf: text("short_title_of"),
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
    /** The cycle (time-boxed iteration) this item is planned into. No FK. */
    cycleId: uuid("cycle_id"),
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
    index("tasks_cycle").on(t.cycleId),
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

/**
 * A time-boxed iteration (Plane "cycle", a.k.a. sprint). projectId null = a
 * cross-project cycle (e.g. "this week"). Items join via tasks.cycle_id.
 * Status is derived from the dates — upcoming / current / completed.
 */
export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id"),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cycles_project").on(t.projectId),
    uniqueIndex("cycles_external_ref").on(t.externalRef).where(sql`${t.externalRef} is not null`),
  ],
);

export type Cycle = typeof cycles.$inferSelect;

/**
 * Item ↔ item relations. Stored once, read from both sides:
 *   blocks      from blocks to   (to is "blocked by" from)
 *   relates     symmetric
 *   duplicates  from duplicates to
 */
export const RELATION_KINDS = ["blocks", "relates", "duplicates"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const taskRelations = pgTable(
  "task_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromId: uuid("from_id").notNull(),
    toId: uuid("to_id").notNull(),
    kind: text("kind", { enum: RELATION_KINDS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("task_relations_pair").on(t.fromId, t.toId, t.kind),
    index("task_relations_to").on(t.toId),
  ],
);

export type TaskRelation = typeof taskRelations.$inferSelect;

/**
 * Evidence attached to an item: commits that mention its identifier, and the
 * Workbench runs it was delegated to. `ref` is the sha / workbench task id;
 * `state` is the last Workbench status written back (so a status is applied
 * to the item once, on transition).
 */
export const LINK_KINDS = ["commit", "workbench"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id").notNull(),
    kind: text("kind", { enum: LINK_KINDS }).notNull(),
    ref: text("ref").notNull(),
    title: text("title"),
    url: text("url"),
    state: text("state"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("task_links_unique").on(t.taskId, t.kind, t.ref),
    index("task_links_ref").on(t.kind, t.ref),
  ],
);

export type TaskLink = typeof taskLinks.$inferSelect;

/** The filter set a saved view restores (all optional; "" / absent = no filter). */
export interface WorkViewFilters {
  q?: string;
  label?: string;
  project?: string;
  feature?: string;
  cycle?: string;
  milestone?: string;
  layout?: "board" | "list" | "calendar";
}

/**
 * Saved views — named filter sets on the Work items tab. projectId scopes a
 * view to one project page; null = a view on all work.
 */
export const workViews = pgTable(
  "work_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id"),
    name: text("name").notNull(),
    filters: jsonb("filters").$type<WorkViewFilters>().notNull().default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("work_views_project").on(t.projectId)],
);

export type WorkView = typeof workViews.$inferSelect;

/**
 * Milestones — a named product stage (Visibility, MVP, …) in one project,
 * made of capabilities and delivery content. Unlike a module (one feature's
 * items) a milestone cuts across modules: it takes whole modules, single
 * items from partly-in-scope modules, other milestones, and any other apOS
 * entity. Progress is resolved from the content at read time.
 */
export const MILESTONE_STATUSES = ["planned", "active", "done", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** One exit criterion — a checkbox the milestone must tick besides its content. */
export interface MilestoneCriterion {
  id: string;
  text: string;
  done: boolean;
}

export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    /** The goal — what reaching this stage means, markdown. */
    description: text("description"),
    status: text("status", { enum: MILESTONE_STATUSES }).notNull().default("planned"),
    targetAt: timestamp("target_at", { withTimezone: true }),
    /** Milestones that must be reached first (the readiness gate). No FK. */
    requires: uuid("requires").array().notNull().default(sql`'{}'::uuid[]`),
    criteria: jsonb("criteria").$type<MilestoneCriterion[]>().notNull().default([]),
    /** Order on the project's roadmap — Visibility before MVP. */
    sortOrder: integer("sort_order").notNull().default(0),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("milestones_project").on(t.projectId)],
);

export type Milestone = typeof milestones.$inferSelect;

/** A named capability inside a milestone — the unit its content is grouped by. */
export const milestoneCapabilities = pgTable(
  "milestone_capabilities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    milestoneId: uuid("milestone_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("milestone_capabilities_milestone").on(t.milestoneId)],
);

export type MilestoneCapability = typeof milestoneCapabilities.$inferSelect;

/**
 * What a milestone delivers, one row each:
 *   module     a whole module — its items, live (items filed later count too)
 *   item       one work item (task, bug, phase…)
 *   milestone  another milestone's whole scope (the MVP contains Visibility)
 *   entity     any other apOS entity (a note, a knowledge item…), with its own
 *              done flag; `entityKind` is its search-index kind
 * `exclude` takes a module or item OUT of what the rest brings in — "all of
 * S17 except S17.9". `label` snapshots the title for entities.
 */
export const MILESTONE_CONTENT_KINDS = ["module", "item", "milestone", "entity"] as const;
export type MilestoneContentKind = (typeof MILESTONE_CONTENT_KINDS)[number];

export const milestoneContent = pgTable(
  "milestone_content",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    milestoneId: uuid("milestone_id").notNull(),
    capabilityId: uuid("capability_id"),
    kind: text("kind", { enum: MILESTONE_CONTENT_KINDS }).notNull(),
    targetId: text("target_id").notNull(),
    entityKind: text("entity_kind"),
    label: text("label"),
    exclude: boolean("exclude").notNull().default(false),
    done: boolean("done").notNull().default(false),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("milestone_content_target").on(t.milestoneId, t.kind, t.targetId),
    index("milestone_content_capability").on(t.capabilityId),
  ],
);

export type MilestoneContent = typeof milestoneContent.$inferSelect;
