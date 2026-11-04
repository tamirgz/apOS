import type { ModuleServerManifest } from "@/core/modules/types.server";
import { askHistory } from "./schema";

export const askServerManifest: ModuleServerManifest = {
  id: "ask",
  schema: { askHistory },
  aiTools: [],
  agentTemplates: [],
};
