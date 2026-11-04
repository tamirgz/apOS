import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { IDEA_CATEGORIES } from "./constants";

export * from "./constants";


export const IDEA_STAGES = [
  "spark",
  "exploring",
  "validated",
  "parked",
] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];

export const ANALYSIS_STATUSES = [
  "none",
  "analyzing",
  "ready",
  "error",
] as const;

/** Structured AI reality-check for an idea. */
export interface IdeaAnalysis {
  verdict: "pursue" | "explore" | "park";
  score: number;
  summary: string;
  strengths: string[];
  risks: string[];
  validationSteps: string[];
}

export const ideas = pgTable("ideas", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  category: text("category", { enum: IDEA_CATEGORIES })
    .notNull()
    .default("product"),
  stage: text("stage", { enum: IDEA_STAGES }).notNull().default("spark"),
  notes: text("notes"),
  analysisStatus: text("analysis_status", { enum: ANALYSIS_STATUSES })
    .notNull()
    .default("none"),
  analysis: jsonb("analysis").$type<IdeaAnalysis>(),
  analysisError: text("analysis_error"),
  /** Set when promoted: "projects:<uuid>". */
  projectRef: text("project_ref"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Idea = typeof ideas.$inferSelect;
