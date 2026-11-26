import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { embeddingVector } from "@/core/db/vector";

/**
 * Letta-style labeled memory blocks — small, size-budgeted context injected
 * into EVERY AI call (chat, agents, enrichment). Agents maintain them via the
 * memory.update tool; the user can edit them in Settings.
 */
export const memoryBlocks = pgTable(
  "memory_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    value: text("value").notNull().default(""),
    charLimit: integer("char_limit").notNull().default(1500),
    /** null = global: injected into every apOS AI call and written only by
     *  the founder in the UI. A project id = that project's block: loaded only
     *  for its sessions and Workbench attempts, written over MCP by them
     *  (AIOS-53). Labels are unique per scope. FK to projects, on delete
     *  cascade, is in the migration (core schema doesn't import modules). */
    scopeProjectId: uuid("scope_project_id"),
    version: integer("version").notNull().default(1),
    /** "apos" (the UI and in-app agents) or "mcp". */
    origin: text("origin").notNull().default("apos"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("memory_blocks_global_label").on(t.label).where(sql`${t.scopeProjectId} is null`),
    uniqueIndex("memory_blocks_scoped_label").on(t.scopeProjectId, t.label).where(sql`${t.scopeProjectId} is not null`),
  ],
);

export type MemoryBlock = typeof memoryBlocks.$inferSelect;

/** Every write to a block over MCP, docs-style: kept 7 days in full, then
 *  each day's last (thinned by the maintenance sweep). */
export const memoryBlockVersions = pgTable(
  "memory_block_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    blockId: uuid("block_id").notNull(),
    version: integer("version").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    value: text("value").notNull(),
    /** "write" | "delete" */
    change: text("change").notNull().default("write"),
    /** Whether the writer passed expectedVersion. */
    guarded: boolean("guarded").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memory_block_versions_version").on(t.blockId, t.version)],
);

export const MEMORY_ENTRY_KINDS = [
  "fact", // semantic — what's true
  "decision", // semantic — a settled choice + its rationale
  "lesson", // procedural — a learned "next time do X"
  "policy", // procedural — a distilled operating rule (from consolidation)
  "event", // episodic — what happened, time-stamped
  "superseded", // episodic — a replaced block value, kept as a trail
  "feedback", // procedural — guidance on how to work (a correction or a confirmed approach)
  "reference", // semantic — a pointer to an outside resource (URL, dashboard, ticket)
] as const;
export type MemoryEntryKind = (typeof MEMORY_ENTRY_KINDS)[number];

/** The cognitive tier a kind belongs to (episodic/semantic/procedural). Kept
 *  next to the kinds so retention, recall, and consolidation agree on it. */
export const MEMORY_TIER: Record<MemoryEntryKind, "episodic" | "semantic" | "procedural"> = {
  fact: "semantic",
  decision: "semantic",
  lesson: "procedural",
  policy: "procedural",
  event: "episodic",
  superseded: "episodic",
  feedback: "procedural",
  reference: "semantic",
};

/**
 * Archival memory — append-only, semantically searchable long-tail memory
 * (Letta's "archival" tier). Core blocks stay small and always-injected;
 * everything else lands here and is retrieved on demand via memory.recall.
 */
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: MEMORY_ENTRY_KINDS }).notNull().default("fact"),
    text: text("text").notNull(),
    /** Where it came from: "chat", "agent:<name>", "block:<label>", "mcp:<actor>". */
    source: text("source").notNull(),
    /** null = global. A project id = visible only to that project's recall,
     *  never in global recall or context. Scoped rows stay out of
     *  search_index (its ~18 readers are global); they search by `embedding`. */
    scopeProjectId: uuid("scope_project_id"),
    /** "apos" (in-app writers; subject to the age rule, the cap and
     *  compaction) or "mcp" (removed only by memory.delete). */
    origin: text("origin").notNull().default("apos"),
    /** One line (≤150) used to decide what to recall; MCP writes set it. */
    description: text("description"),
    /** Ids of related entries. */
    links: uuid("links").array().notNull().default(sql`'{}'::uuid[]`),
    version: integer("version").notNull().default(1),
    /** The entry's own vector (MCP writes); apOS rows use search_index's. */
    embedding: embeddingVector("embedding"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("memory_entries_created").on(t.createdAt),
    index("memory_entries_scope").on(t.scopeProjectId),
    check("memory_entries_description_len", sql`char_length(${t.description}) <= 150`),
  ],
);

export type MemoryEntry = typeof memoryEntries.$inferSelect;

/** Every write to an MCP entry; same retention as docs. */
export const memoryEntryVersions = pgTable(
  "memory_entry_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entryId: uuid("entry_id").notNull(),
    version: integer("version").notNull(),
    kind: text("kind").notNull(),
    description: text("description"),
    text: text("text").notNull(),
    links: uuid("links").array().notNull().default(sql`'{}'::uuid[]`),
    scopeProjectId: uuid("scope_project_id"),
    change: text("change").notNull().default("write"),
    guarded: boolean("guarded").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memory_entry_versions_version").on(t.entryId, t.version)],
);
