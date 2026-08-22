import { z } from "zod";
import { desc, eq, or, sql as dsql } from "drizzle-orm";
import type { AiToolDef } from "@/core/modules/types.server";
import { sql } from "@/core/db/client";
import { registerRefs, resolveRef } from "@/core/ai/refs";
import { detectKind } from "./detect";
import { findDuplicateKnowledge } from "./dedup";
import { knowledgeItems, KNOWLEDGE_KINDS } from "./schema";

export const knowledgeTools: AiToolDef[] = [
  {
    name: "knowledge.capture",
    description:
      "Save something into the user's knowledge base (a URL, repo, quote, or text snippet). It will be fetched and AI-enriched automatically. Skips capture if the same link or snippet is already saved (returns the existing item).",
    input: z.object({
      input: z.string().min(1).describe("The URL or text to save"),
      note: z
        .string()
        .optional()
        .describe("Why this is interesting / what to look for"),
    }),
    async execute(input, { db }) {
      const trimmed = input.input.trim();
      const { kind, url } = detectKind(trimmed);

      // Don't capture the same link/snippet twice.
      const existing = await findDuplicateKnowledge({ input: trimmed, url });
      if (existing)
        return {
          duplicate: true,
          existing: {
            id: existing.id,
            kind: existing.kind,
            title: existing.title ?? existing.input.slice(0, 80),
            status: existing.status,
          },
          note: "Already in the knowledge base — not captured again.",
        };

      const [row] = await db
        .insert(knowledgeItems)
        .values({ input: trimmed, kind, url, note: input.note ?? null })
        .returning();
      await sql.notify("knowledge_ingest", row.id);
      return { captured: { id: row.id, kind: row.kind } };
    },
  },
  {
    name: "knowledge.search",
    description:
      "Search the user's knowledge base (saved repos, links, videos, quotes, snippets and their AI-extracted insights).",
    input: z.object({
      query: z.string().min(1),
      kind: z.enum(KNOWLEDGE_KINDS).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async execute(input, ctx) {
      const q = `%${input.query}%`;
      const rows = await ctx.db
        .select()
        .from(knowledgeItems)
        .where(
          input.kind
            ? dsql`${knowledgeItems.kind} = ${input.kind} and (${knowledgeItems.title} ilike ${q} or ${knowledgeItems.input} ilike ${q} or ${knowledgeItems.insight}::text ilike ${q})`
            : or(
                dsql`${knowledgeItems.title} ilike ${q}`,
                dsql`${knowledgeItems.input} ilike ${q}`,
                dsql`${knowledgeItems.insight}::text ilike ${q}`,
              ),
        )
        .orderBy(desc(knowledgeItems.createdAt))
        .limit(input.limit);
      // Short handles (k1, k2…) so knowledge.read targets the right item by ref.
      return registerRefs(
        ctx,
        "knowledge",
        "k",
        rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title ?? r.input.slice(0, 80),
          status: r.status,
          summary: r.insight?.summary ?? null,
          tags: r.insight?.tags ?? [],
        })),
      );
    },
  },
  {
    name: "knowledge.read",
    description:
      "Read one knowledge item in full: its insight (summary, key ideas, use cases, quotes) and source material. Identify it by its `ref` from knowledge.search (e.g. 'k2').",
    input: z.object({
      ref: z.string().describe("Knowledge ref from knowledge.search, e.g. 'k2'"),
    }),
    async execute(input, ctx) {
      const t = resolveRef(ctx, "knowledge", input.ref);
      if ("error" in t) return t;
      const [row] = await ctx.db
        .select()
        .from(knowledgeItems)
        .where(eq(knowledgeItems.id, t.id));
      if (!row) return { error: "not found" };
      return {
        id: row.id,
        kind: row.kind,
        url: row.url,
        title: row.title,
        note: row.note,
        status: row.status,
        insight: row.insight,
      };
    },
  },
];
