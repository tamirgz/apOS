import type { ModulePagesManifest } from "@/core/modules/types.server";
import { ModelsPage } from "./pages/ModelsPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { UsagePage } from "./pages/UsagePage";
import { ActivityPage } from "./pages/ActivityPage";
import { AppearancePage } from "./pages/AppearancePage";

export const settingsPagesManifest: ModulePagesManifest = {
  id: "settings",
  routes: {
    "": ModelsPage,
    models: ModelsPage,
    connections: ConnectionsPage,
    appearance: AppearancePage,
    memory: MemoryPage,
    usage: UsagePage,
    activity: ActivityPage,
  },
};
