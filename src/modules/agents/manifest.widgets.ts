import type { ModuleWidgets } from "@/core/modules/types.server";
import { AgentActivityWidget, AgentsOkLine, agentsAllOk } from "./widgets/AgentActivityWidget";

export const agentsWidgets: ModuleWidgets = {
  id: "agents",
  widgets: [
    {
      id: "agent-activity",
      title: "Agent activity",
      size: "md",
      component: AgentActivityWidget,
      compact: { when: agentsAllOk, component: AgentsOkLine },
    },
  ],
};
