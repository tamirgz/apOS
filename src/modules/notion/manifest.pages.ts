import type { ModulePagesManifest } from "@/core/modules/types.server";
import { NotionPage } from "./pages/NotionPage";

export const notionPagesManifest: ModulePagesManifest = {
  id: "notion",
  routes: {
    "": NotionPage,
  },
};
