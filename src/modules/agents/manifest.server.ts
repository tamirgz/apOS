import type { ModuleServerManifest } from "@/core/modules/types.server";
import { externalReports } from "./schema";
import { externalReportJobs } from "./external";
import { slackIntakeJobs } from "./slack-intake";
import { memoryMaintenanceJobs } from "./memory-maintenance";
import { memoryDistillJobs } from "./memory-distill";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentDetailPage } from "./pages/AgentDetailPage";
import { AgentModelsPage } from "./pages/AgentModelsPage";
import { AgentActivityWidget, AgentsOkLine, agentsAllOk } from "./widgets/AgentActivityWidget";

export const agentsServerManifest: ModuleServerManifest = {
  id: "agents",
  routes: {
    "": AgentsPage,
    models: AgentModelsPage,
    "[id]": AgentDetailPage,
  },
  widgets: [
    {
      id: "agent-activity",
      title: "Agent activity",
      size: "md",
      component: AgentActivityWidget,
      compact: { when: agentsAllOk, component: AgentsOkLine },
    },
  ],
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
