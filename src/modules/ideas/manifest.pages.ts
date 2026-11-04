import type { ModulePagesManifest } from "@/core/modules/types.server";
import { IdeasPage } from "./pages/IdeasPage";
import { IdeaDetailPage } from "./pages/IdeaDetailPage";

export const ideasPagesManifest: ModulePagesManifest = {
  id: "ideas",
  routes: {
    "": IdeasPage,
    "[id]": IdeaDetailPage,
  },
};
