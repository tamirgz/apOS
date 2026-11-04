import type { ModuleServerManifest } from "@/core/modules/types.server";
import { connectionHealthJobs } from "./connection-health";

export const settingsServerManifest: ModuleServerManifest = {
  id: "settings",
  schema: {},
  aiTools: [],
  agentTemplates: [],
  jobs: [...connectionHealthJobs],
};
