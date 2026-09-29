import type { TaskPriority, TaskStatus } from "./schema";

/** Display metadata for work-item states — shared by board, list, drawer and tools. */
export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  backlog: { label: "Backlog", color: "var(--color-ink-faint)" },
  todo: { label: "Todo", color: "var(--color-ion)" },
  doing: { label: "In progress", color: "var(--color-solar)" },
  review: { label: "In review", color: "var(--color-violet)" },
  done: { label: "Done", color: "var(--color-plasma)" },
  cancelled: { label: "Cancelled", color: "var(--color-ink-faint)" },
};

/** The board's columns, left → right. Cancelled lives in the list view only. */
export const BOARD_STATUSES: TaskStatus[] = ["backlog", "todo", "doing", "review", "done"];

export const PRIORITY_META: Record<TaskPriority, { label: string; className: string; rank: number }> = {
  urgent: { label: "Urgent", className: "text-flare", rank: 0 },
  high: { label: "High", className: "text-flare/80", rank: 1 },
  medium: { label: "Medium", className: "text-solar", rank: 2 },
  low: { label: "Low", className: "text-ink-faint", rank: 3 },
};

export const ESTIMATES = [1, 2, 3, 5, 8, 13] as const;

/** How an item relation reads from one side (stored once as blocks / relates / duplicates). */
export type RelationSide = "blocks" | "blocked_by" | "relates" | "duplicates" | "duplicated_by";

export const RELATION_SIDE_LABEL: Record<RelationSide, string> = {
  blocks: "blocks",
  blocked_by: "blocked by",
  relates: "relates to",
  duplicates: "duplicates",
  duplicated_by: "duplicated by",
};

/**
 * A title as shown on cards and rows: inline markdown markers stripped
 * (imported titles often carry **bold** / `code`), text kept.
 */
export function plainTitle(title: string): string {
  return title
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .trim();
}
