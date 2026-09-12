import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const KNOWLEDGE_KINDS = [
  "github",
  "instagram",
  "tiktok",
  "youtube",
  "link",
  "quote",
  "text",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = [
  "captured",
  "fetching",
  "enriching",
  "ready",
  "error",
] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/** Structured enrichment produced by the AI pipeline. */
export interface KnowledgeInsight {
  summary: string;
  keyIdeas: string[];
  useCases: string[];
  quotes: string[];
  tags: string[];
  relevance: string;
  /** Primary theme the item belongs to — the board groups by this. Free-form
   *  but REUSED (the AI is seeded with the existing set), like project
   *  categories, so a handful of stable shelves emerge instead of 40 tag
   *  fragments. Mirrored to the top-level `category` column for grouping/editing. */
  category: string;
}

export const knowledgeItems = pgTable("knowledge_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Raw pasted input. */
  input: text("input").notNull(),
  kind: text("kind", { enum: KNOWLEDGE_KINDS }).notNull(),
  url: text("url"),
  title: text("title"),
  /** User's own note about why this was saved. */
  note: text("note"),
  status: text("status", { enum: KNOWLEDGE_STATUSES })
    .notNull()
    .default("captured"),
  statusDetail: text("status_detail"),
  /** Primary theme for board grouping — set by enrichment, editable by the user
   *  (free-form + reused, like project categories). Null until classified. */
  category: text("category"),
  /** Fetched source material (readme, oembed, page text …). */
  raw: jsonb("raw"),
  insight: jsonb("insight").$type<KnowledgeInsight>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type KnowledgeItem = typeof knowledgeItems.$inferSelect;
