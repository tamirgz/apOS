"use server";

import { and, desc, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/core/db/client";
import { searchIndex } from "@/core/db/schema/search-index";
import type { CommandSearchHit } from "./types";

/**
 * Context-aware ⌘K search: when the bar is open on a module's page, search that
 * module's own content. Everything flows through the unified `search_index`
 * (one row per source item, kept fresh by the worker), so a module lights up by
 * mapping its page id → the index `kind`(s) it owns here and setting
 * `searchable: true` on its manifest — no per-module query code.
 */
const MODULE_KINDS: Record<string, string[]> = {
  tasks: ["task"],
  notes: ["note"],
  ideas: ["idea"],
  projects: ["project", "feature"],
  people: ["person"],
  knowledge: ["knowledge"],
  inbox: ["inbox"],
  workbench: ["workbench"],
  calendar: ["event"],
  ask: ["ask"],
  agents: ["report"],
  telegram: ["telegram"],
};

/** A real detail route (/m/<mod>/<id>); list-only kinds fall back to the page. */
const isDetailHref = (href: string | null) => !!href && /^\/m\/[^/]+\/.+/.test(href);

export async function searchModule(
  moduleId: string,
  query: string,
): Promise<CommandSearchHit[]> {
  const q = query.trim();
  const kinds = MODULE_KINDS[moduleId];
  if (!q || !kinds) return [];
  const like = `%${q}%`;
  const rows = await db
    .select({
      id: searchIndex.id,
      title: searchIndex.title,
      snippet: searchIndex.snippet,
      href: searchIndex.href,
    })
    .from(searchIndex)
    .where(
      and(
        inArray(searchIndex.kind, kinds),
        or(
          ilike(searchIndex.title, like),
          ilike(searchIndex.snippet, like),
          ilike(searchIndex.embedText, like),
        ),
      ),
    )
    .orderBy(desc(searchIndex.updatedAt))
    .limit(8);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.snippet ?? undefined,
    // Detail route when the source has one; otherwise land on the module page.
    href: isDetailHref(r.href) ? r.href! : `/m/${moduleId}`,
  }));
}
