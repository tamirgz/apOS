import type { ModuleServerManifest } from "@/core/modules/types.server";
import { StudioPage } from "./pages/StudioPage";
import { FlowEditorPage } from "./pages/FlowEditorPage";

/**
 * Studio — the visual builder for Flows. The `flows` module owns the schema +
 * engine (headless); Studio owns the UI: a flow library (root) and a canvas
 * editor (one dynamic segment = flow id). Data reads live in queries.ts, writes
 * in the "use server" actions.ts.
 */
export const studioServerManifest: ModuleServerManifest = {
  id: "studio",
  routes: {
    "": StudioPage,
    "[id]": FlowEditorPage,
  },
  widgets: [],
  schema: {},
  aiTools: [],
  agentTemplates: [],
};
