import type { ModulePagesManifest } from "@/core/modules/types.server";
import { KnowledgePage } from "./pages/KnowledgePage";
import { KnowledgeDetailPage } from "./pages/KnowledgeDetailPage";

export const knowledgePagesManifest: ModulePagesManifest = {
  id: "knowledge",
  routes: {
    "": KnowledgePage,
    "[id]": KnowledgeDetailPage,
  },
};
