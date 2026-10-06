import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "@/core/db/bytea";

export const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * What kind of "project" this row is:
 *   - "project" — a goal-oriented effort the user created (the default; every
 *     existing row). Has deliverables, a goal, a next action, health.
 *   - "area"    — a standing area of personal development (Finance, Career,
 *     Health…). A bucket to file things under, not a deliverable — so the UI
 *     lists these separately and skips the goal/next-action/health nudges.
 * Both live in one table so anything that links to a project (via a
 * "projects:<uuid>" ref) can just as easily link to an area.
 */
export const PROJECT_KINDS = ["project", "area"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/**
 * Life-OS L2 health. Derived cheaply on read (so the cockpit always shows one,
 * even before any agent runs), then refined by the Project-pulse agent, which
 * can also set "blocked" — a judgement the heuristic can't make.
 */
export const PROJECT_HEALTHS = [
  "on_track",
  "at_risk",
  "stalled",
  "blocked",
] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /**
   * Short uppercase prefix for work-item identifiers ("ETHOS" → ETHOS-12).
   * Derived from the name on first need (tasks/keys.ts), unique, editable.
   */
  key: text("key").unique(),
  description: text("description"),
  /**
   * Free-form single category the project belongs to ("Shahar", "Startup",
   * "Self"…). Free-form so personal groupings fit; the Projects page groups by
   * it and the cockpit suggests already-used values. Null = uncategorized.
   */
  category: text("category"),
  /** "project" (default) vs "area" of development — see PROJECT_KINDS. */
  kind: text("kind", { enum: PROJECT_KINDS }).notNull().default("project"),
  status: text("status", { enum: PROJECT_STATUSES })
    .notNull()
    .default("active"),
  /**
   * The north-star outcome this project is for (one line). The user's own —
   * agents can't set it (projects.setGoal refuses agent runs).
   */
  goal: text("goal"),
  /**
   * The single next physical step (GTD). Life-OS L1: this is what wires a
   * project to the day — Plan-my-day pulls active projects' next-actions as
   * "do" suggestions, and the chaser flags a missing or stale one. Derived by
   * the Project-pulse agent (L2), settable by hand.
   */
  nextAction: text("next_action"),
  /**
   * Code grounding: a git remote (GitHub URL) or absolute local path. The
   * worker keeps a read-only clone at ~/.aios/repos/<projectId> so agents can
   * read the real code when working this project. Nullable = no repo attached.
   */
  repoUrl: text("repo_url"),
  /**
   * L2 health, as last written by the Project-pulse agent. Nullable: when null
   * (or stale) the cockpit falls back to the read-time heuristic, so a project
   * always shows a health without anyone setting it.
   */
  health: text("health", { enum: PROJECT_HEALTHS }),
  /** One-line "why" behind `health` — shown in the cockpit. */
  healthReason: text("health_reason"),
  /** When the agent last wrote `health` (staleness gate for the fallback). */
  healthUpdatedAt: timestamp("health_updated_at", { withTimezone: true }),
  /**
   * Who wrote `health`: an agent's guess yields to newer activity; the user's
   * own call (via chat) is kept. Null on rows written before this existed.
   */
  healthBy: text("health_by", { enum: ["agent", "user"] }),
  /**
   * P1 Project Advisor read (chief-of-staff synthesis, written by the
   * Project-advisor agent): where it stands · the real blocker · next move.
   */
  advisorState: text("advisor_state"),
  advisorBlocker: text("advisor_blocker"),
  advisorNext: text("advisor_next"),
  advisorUpdatedAt: timestamp("advisor_updated_at", { withTimezone: true }),
  /**
   * When the advisor FIRST made its current recommendation. A reworded repeat
   * (advice.ts sameMove) keeps it, so a suggestion can't renew itself by
   * paraphrase — the read tells the agent its age, and a stale one is refused.
   */
  advisorNextSince: timestamp("advisor_next_since", { withTimezone: true }),
  /** A1 Repo-watcher routine: a short "what's moving in the code" digest of the
   * attached repo's recent commits, refreshed on a schedule. Feeds the advisor. */
  repoDigest: text("repo_digest"),
  repoDigestAt: timestamp("repo_digest_at", { withTimezone: true }),
  /** Commit-linking ledger: the last HEAD scanned for KEY-N mentions (work tracker). */
  workLinkSha: text("work_link_sha"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Project = typeof projects.$inferSelect;

/**
 * Feature lifecycle (Plane's module states, trimmed). Mostly self-driving —
 * tasks/core.ts syncs it whenever an item changes:
 *   planned → active   when any item starts moving (doing/review/done)
 *   active  → shipped  when its last open item closes (stamps shippedAt)
 *   shipped → active   when an item is reopened or a new one is added
 * paused / cancelled are manual and never auto-changed.
 */
export const FEATURE_STATUSES = ["planned", "active", "paused", "shipped", "cancelled"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/**
 * A feature — a mid-layer between project and task. A feature belongs to one
 * project and groups multiple tasks (tasks.featureRef = "features:<id>").
 * Progress is derived from its tasks at read time; status follows them (above).
 */
export const features = pgTable(
  "features",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: FEATURE_STATUSES }).notNull().default("active"),
    /** When work on it starts — with targetAt, the feature's span on the timeline. */
    startAt: timestamp("start_at", { withTimezone: true }),
    /** Target date — the feature's deadline on the roadmap. */
    targetAt: timestamp("target_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    /** Where an imported feature came from, e.g. "plane-module:<uuid>". */
    externalRef: text("external_ref"),
    /** Manual order within the project's feature list. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("features_project").on(t.projectId)],
);

export type Feature = typeof features.$inferSelect;

/** The entity ref stored in tasks.featureRef for a given feature row. */
export const featureRefOf = (id: string) => `features:${id}`;

/** Sort helper: active → paused → done (text enum, so plain asc would be wrong). */
export const statusRank = sql`case ${projects.status} when 'active' then 0 when 'paused' then 1 when 'done' then 2 else 3 end`;

/** The entity ref stored in tasks.projectRef for a given project row. */
export function projectRefOf(id: string) {
  return `projects:${id}`;
}

export const PROJECT_FILE_STATUSES = [
  "processing",
  "ready",
  "error",
  "unsupported",
] as const;
export type ProjectFileStatus = (typeof PROJECT_FILE_STATUSES)[number];

/**
 * Files attached to a project. The raw bytes live in Postgres (`content`,
 * bytea) rather than a separate storage layer — there is no filesystem/S3
 * convention anywhere else in apOS, and this way attachments are covered by
 * the existing nightly `pg_dump` backup for free. `extractedText` is what
 * gets embedded and what search/Ask/agents actually read; `content` is only
 * served back on download.
 */
export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Owning project's id — same-module ownership, not a droppable cross-ref. */
    projectId: uuid("project_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull(),
    content: bytea("content").notNull(),
    /** Plain text pulled from the file (pdf/docx parsed, else read as-is). */
    extractedText: text("extracted_text"),
    status: text("status", { enum: PROJECT_FILE_STATUSES })
      .notNull()
      .default("processing"),
    statusDetail: text("status_detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("project_files_project").on(t.projectId)],
);

export type ProjectFile = typeof projectFiles.$inferSelect;
