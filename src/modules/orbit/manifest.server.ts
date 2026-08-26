import type { ModuleServerManifest } from "@/core/modules/types.server";
import { OrbitPage } from "./pages/OrbitPage";

export const orbitServerManifest: ModuleServerManifest = {
  id: "orbit",
  routes: {
    "": OrbitPage,
  },
  widgets: [],
  schema: {},
  aiTools: [],
  agentTemplates: [],
};
