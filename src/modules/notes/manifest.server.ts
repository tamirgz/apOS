import type { ModuleServerManifest } from "@/core/modules/types.server";
import { notes } from "./schema";
import { noteTools } from "./tools";

export const notesServerManifest: ModuleServerManifest = {
  id: "notes",
  schema: { notes },
  aiTools: noteTools,
  agentTemplates: [],
};
