import type { ModuleServerManifest } from "@/core/modules/types.server";
import { OrbitPage } from "./pages/OrbitPage";
import { refreshAtlas } from "./atlas";

export const orbitServerManifest: ModuleServerManifest = {
  id: "orbit",
  routes: {
    "": OrbitPage,
  },
  widgets: [],
  schema: {},
  aiTools: [],
  agentTemplates: [],
  jobs: [
    {
      // Rebuild the semantic atlas (2D projection + qwen-named topic regions)
      // when the corpus changes. Heavy + LLM-backed, so it lives here — never on
      // the page render path.
      channel: "orbit.atlas",
      schedule: "*/15 * * * *",
      runOnBoot: true,
      handle: () => refreshAtlas(),
    },
  ],
};
