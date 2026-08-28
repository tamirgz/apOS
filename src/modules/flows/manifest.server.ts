import type { ModuleServerManifest } from "@/core/modules/types.server";
import { flowNodeRuns, flowRuns, flows } from "./schema";

/**
 * Flows — multi-agent procedures. Phase 1 is headless: this registers the
 * schema (so migrations create the tables) and the Flow Engine runs flows on
 * demand. The Studio canvas + scheduling arrive in later phases.
 */
export const flowsServerManifest: ModuleServerManifest = {
  id: "flows",
  routes: {},
  widgets: [],
  schema: { flows, flowRuns, flowNodeRuns },
  aiTools: [],
  agentTemplates: [],
};
