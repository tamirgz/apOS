"use server";

import { searchKnowledgeForCommand } from "@/modules/knowledge/actions";
import type { CommandSearchHit } from "./types";

/**
 * Context-aware ⌘K search: when the bar is open on a module's page, search that
 * module's own content. Dispatches to per-module search by id — add a case here
 * (and set `searchable: true` on the module manifest) to light up a new module.
 * Currently: knowledge.
 */
export async function searchModule(
  moduleId: string,
  query: string,
): Promise<CommandSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  switch (moduleId) {
    case "knowledge":
      return searchKnowledgeForCommand(q);
    default:
      return [];
  }
}
