// Client-safe: the work-item and milestone enums, free of drizzle so client
// components can import them. schema.ts re-exports them.

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

/** A milestone's own lifecycle (see milestones in schema.ts). */
export const MILESTONE_STATUSES = ["planned", "active", "done", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
