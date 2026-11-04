import type { ModuleServerManifest } from "@/core/modules/types.server";
import { externalReports } from "./schema";
import { externalReportJobs } from "./external";
import { slackIntakeJobs } from "./slack-intake";
import { memoryMaintenanceJobs } from "./memory-maintenance";
import { memoryDistillJobs } from "./memory-distill";

export const agentsServerManifest: ModuleServerManifest = {
  id: "agents",
  // Core owns agents/agent_runs; this module owns external_reports.
  schema: { externalReports },
  aiTools: [],
  jobs: [
    ...externalReportJobs,
    ...slackIntakeJobs,
    ...memoryMaintenanceJobs,
    ...memoryDistillJobs,
  ],
  // The weekly "Memory consolidation" template is retired: active_projects is
  // built from the tracker in code (projects/active-projects.ts).
  agentTemplates: [],
};
