import type { ModuleServerManifest } from "@/core/modules/types.server";
import { obsidianNotes } from "./schema";
import { obsidianTools } from "./tools";
import { obsidianJobs } from "./sync";

export const obsidianServerManifest: ModuleServerManifest = {
  id: "vault",
  schema: { obsidianNotes },
  aiTools: obsidianTools,
  agentTemplates: [],
  jobs: obsidianJobs,
};
