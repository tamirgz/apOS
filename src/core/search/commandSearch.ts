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
  projects: ["project", "feature", "file"],
  people: ["person"],
  knowledge: ["knowledge"],
  inbox: ["inbox"],
  workbench: ["workbench"],
  calendar: ["event"],
  ask: ["ask"],
  agents: ["report"],
  telegram: ["telegram"],
  gmail: ["mail"],
  vault: ["vault"],
  notion: ["notion"],
};

/** Where a hit lands when its index row has no usable detail href. */
const KIND_FALLBACK_HREF: Record<string, string> = {
  task: "/m/tasks",
  note: "/m/notes",
  idea: "/m/ideas",
  project: "/m/projects",
  feature: "/m/projects",
  file: "/m/projects",
  person: "/m/people",
  knowledge: "/m/knowledge",
  inbox: "/m/inbox",
  workbench: "/m/workbench",
  event: "/m/calendar",
  ask: "/m/ask",
  report: "/m/agents",
  telegram: "/m/telegram",
  mail: "/m/gmail",
  vault: "/m/vault",
  notion: "/m/notion",
  memory: "/m/settings/memory",
  attention: "/m/today",
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

/**
 * Global ⌘K search: the WHOLE unified index, from anywhere — the dashboard,
 * Today, a settings page. Lexical (fast enough for typeahead; the semantic
 * layer stays in Ask/search.everything). Returns the hit's `kind` so the
 * palette can label and icon it.
 */
export async function searchEverywhere(
  query: string,
): Promise<(CommandSearchHit & { kind: string })[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const rows = await db
    .select({
      id: searchIndex.id,
      kind: searchIndex.kind,
      title: searchIndex.title,
      snippet: searchIndex.snippet,
      href: searchIndex.href,
    })
    .from(searchIndex)
    .where(
      or(
        ilike(searchIndex.title, like),
        ilike(searchIndex.snippet, like),
        ilike(searchIndex.embedText, like),
      ),
    )
    .orderBy(desc(searchIndex.updatedAt))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    subtitle: r.snippet ?? undefined,
    href:
      (isDetailHref(r.href) ? r.href : null) ??
      r.href ??
      KIND_FALLBACK_HREF[r.kind] ??
      "/",
  }));
}
