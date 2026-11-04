import type { ModulePagesManifest } from "@/core/modules/types.server";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentDetailPage } from "./pages/AgentDetailPage";
import { AgentModelsPage } from "./pages/AgentModelsPage";

export const agentsPagesManifest: ModulePagesManifest = {
  id: "agents",
  routes: {
    "": AgentsPage,
    models: AgentModelsPage,
    "[id]": AgentDetailPage,
  },
};
