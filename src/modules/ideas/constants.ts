// Client-safe (no drizzle); schema.ts re-exports it.
export const IDEA_CATEGORIES = [
  "product",
  "business",
  "feature",
  "experiment",
  "other",
] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];
