// Today-card registry — ONE line per module that puts a card on Today.
import type { ModuleWidgets } from "@/core/modules/types.server";
import { calendarWidgets } from "./calendar/manifest.widgets";
import { todayWidgets } from "./today/manifest.widgets";
import { inboxWidgets } from "./inbox/manifest.widgets";
import { workbenchWidgets } from "./workbench/manifest.widgets";
import { projectsWidgets } from "./projects/manifest.widgets";
import { agentsWidgets } from "./agents/manifest.widgets";

/** In the order the old server registry listed them, so the deck keeps its order. */
export function getModuleWidgets(): ModuleWidgets[] {
  return [todayWidgets, inboxWidgets, calendarWidgets, workbenchWidgets, projectsWidgets, agentsWidgets];
}
