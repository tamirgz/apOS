// Server-side module registry — ONE line per module, mirroring registry.ts.
import type { ModuleServerManifest } from "@/core/modules/types.server";
import { tasksServerManifest } from "./tasks/manifest.server";
import { projectsServerManifest } from "./projects/manifest.server";
import { notesServerManifest } from "./notes/manifest.server";
import { ideasServerManifest } from "./ideas/manifest.server";
import { settingsServerManifest } from "./settings/manifest.server";
import { knowledgeServerManifest } from "./knowledge/manifest.server";
import { agentsServerManifest } from "./agents/manifest.server";
import { calendarServerManifest } from "./calendar/manifest.server";
import { inboxServerManifest } from "./inbox/manifest.server";
import { obsidianServerManifest } from "./obsidian/manifest.server";
import { workbenchServerManifest } from "./workbench/manifest.server";
import { todayServerManifest } from "./today/manifest.server";
import { peopleServerManifest } from "./people/manifest.server";
import { gmailServerManifest } from "./gmail/manifest.server";
import { askServerManifest } from "./ask/manifest.server";
import { notionServerManifest } from "./notion/manifest.server";
import { telegramServerManifest } from "./telegram/manifest.server";
import { investmentsServerManifest } from "./investments/manifest.server";
import { orbitServerManifest } from "./orbit/manifest.server";
import { flowsServerManifest } from "./flows/manifest.server";
import { studioServerManifest } from "./studio/manifest.server";

export const serverModules: ModuleServerManifest[] = [
  todayServerManifest,
  askServerManifest,
  inboxServerManifest,
  calendarServerManifest,
  gmailServerManifest,
  workbenchServerManifest,
  tasksServerManifest,
  projectsServerManifest,
  peopleServerManifest,
  notesServerManifest,
  ideasServerManifest,
  investmentsServerManifest,
  knowledgeServerManifest,
  orbitServerManifest,
  flowsServerManifest,
  studioServerManifest,
  obsidianServerManifest,
  notionServerManifest,
  telegramServerManifest,
  agentsServerManifest,
  settingsServerManifest,
];

export function getServerModule(
  id: string,
): ModuleServerManifest | undefined {
  return serverModules.find((m) => m.id === id);
}
