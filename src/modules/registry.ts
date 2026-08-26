// Client-safe module registry — ONE line per module. Adding a module to the
// system means adding its manifest here and in registry.server.ts.
import type { ModuleManifest } from "@/core/modules/types";
import { tasksManifest } from "./tasks/manifest";
import { projectsManifest } from "./projects/manifest";
import { notesManifest } from "./notes/manifest";
import { ideasManifest } from "./ideas/manifest";
import { settingsManifest } from "./settings/manifest";
import { knowledgeManifest } from "./knowledge/manifest";
import { agentsManifest } from "./agents/manifest";
import { calendarManifest } from "./calendar/manifest";
import { inboxManifest } from "./inbox/manifest";
import { obsidianManifest } from "./obsidian/manifest";
import { workbenchManifest } from "./workbench/manifest";
import { todayManifest } from "./today/manifest";
import { peopleManifest } from "./people/manifest";
import { gmailManifest } from "./gmail/manifest";
import { askManifest } from "./ask/manifest";
import { notionManifest } from "./notion/manifest";
import { telegramManifest } from "./telegram/manifest";
import { investmentsManifest } from "./investments/manifest";
import { orbitManifest } from "./orbit/manifest";

export const modules: ModuleManifest[] = [
  todayManifest,
  askManifest,
  inboxManifest,
  calendarManifest,
  gmailManifest,
  workbenchManifest,
  tasksManifest,
  projectsManifest,
  peopleManifest,
  notesManifest,
  ideasManifest,
  investmentsManifest,
  knowledgeManifest,
  orbitManifest,
  obsidianManifest,
  notionManifest,
  telegramManifest,
  agentsManifest,
  settingsManifest,
];

export const navModules = [...modules].sort(
  (a, b) => a.nav.order - b.nav.order,
);

export function getModule(id: string): ModuleManifest | undefined {
  return modules.find((m) => m.id === id);
}
