import type { ModuleServerManifest } from "@/core/modules/types.server";
import { ModelsPage } from "./pages/ModelsPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { UsagePage } from "./pages/UsagePage";
import { ActivityPage } from "./pages/ActivityPage";
import { AppearancePage } from "./pages/AppearancePage";
import { connectionHealthJobs } from "./connection-health";

export const settingsServerManifest: ModuleServerManifest = {
  id: "settings",
  // Settings is split into focused sub-pages (a shared tab nav switches them);
  // the root defaults to Models & Routing.
  routes: {
    "": ModelsPage,
    models: ModelsPage,
    connections: ConnectionsPage,
    appearance: AppearancePage,
    memory: MemoryPage,
    usage: UsagePage,
    activity: ActivityPage,
  },
  widgets: [],
  schema: {},
  aiTools: [],
  agentTemplates: [],
  jobs: [...connectionHealthJobs],
};
