// Client-safe (no drizzle); schema.ts re-exports it.
export const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
