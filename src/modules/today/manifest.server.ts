import type { ModuleServerManifest } from "@/core/modules/types.server";
import { attentionItems } from "./schema";
import { todayTools } from "./tools";
import { todayJobs } from "./jobs";

export const todayServerManifest: ModuleServerManifest = {
  id: "today",
  schema: { attentionItems },
  aiTools: todayTools,
  // The morning plan is now the DETERMINISTIC `today.plan` job (see ./planner),
  // not an LLM agent — a local model kept "succeeding" without ever calling
  // attention.raise, leaving "Needs you" silently empty. No agent template here.
  agentTemplates: [],
  jobs: todayJobs,
};
