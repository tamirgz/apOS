import type { ModuleServerManifest } from "@/core/modules/types.server";
import { gmailMessages } from "./schema";
import { gmailTools } from "./tools";
import { gmailJobs } from "./jobs";

export const gmailServerManifest: ModuleServerManifest = {
  id: "gmail",
  schema: { gmailMessages },
  aiTools: gmailTools,
  jobs: gmailJobs,
  agentTemplates: [],
};
