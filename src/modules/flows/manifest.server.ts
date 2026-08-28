import type { ModuleServerManifest } from "@/core/modules/types.server";
import { runFlow } from "./engine";
import { flowNodeRuns, flowRuns, flows } from "./schema";

/**
 * Flows — multi-agent procedures. Still headless: this registers the schema (so
 * migrations create the tables) and the Flow Engine runs flows on demand, now
 * with branch / fan-out / merge / filter orchestration. The Studio canvas +
 * scheduling arrive in later phases.
 */
export const flowsServerManifest: ModuleServerManifest = {
  id: "flows",
  routes: {},
  widgets: [],
  schema: { flows, flowRuns, flowNodeRuns },
  aiTools: [],
  agentTemplates: [],
  // The Studio "Run" button NOTIFYs this channel; the worker runs the flow off
  // the request path so heavy agent runs don't tie up the web process.
  jobs: [
    {
      channel: "flow_run",
      handle: async (payload: string) => {
        if (payload) await runFlow(payload, "manual");
      },
    },
  ],
};
