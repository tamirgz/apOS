import type { ModuleServerManifest } from "@/core/modules/types.server";
import { refreshAtlas } from "./atlas";

export const orbitServerManifest: ModuleServerManifest = {
  id: "orbit",
  schema: {},
  aiTools: [],
  agentTemplates: [],
  jobs: [
    {
      // Rebuild the semantic atlas (2D projection + qwen-named topic regions)
      // when the corpus changed, at most once a day (refreshAtlas decides).
      // Heavy + LLM-backed, so it lives here — never on the page render path.
      // Hourly is only the check; a run that finds nothing to do is one read.
      channel: "orbit.atlas",
      schedule: "23 * * * *",
      runOnBoot: true,
      handle: () => refreshAtlas(),
    },
  ],
};
