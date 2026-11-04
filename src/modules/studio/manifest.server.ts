import type { ModuleServerManifest } from "@/core/modules/types.server";

/**
 * Studio — the visual builder for Flows. The `flows` module owns the schema +
 * engine (headless); Studio owns the UI: a flow library (root) and a canvas
 * editor (one dynamic segment = flow id). Data reads live in queries.ts, writes
 * in the "use server" actions.ts.
 */
export const studioServerManifest: ModuleServerManifest = {
  id: "studio",
  schema: {},
  aiTools: [],
  agentTemplates: [],
};
