import type { ModulePagesManifest } from "@/core/modules/types.server";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";

export const projectsPagesManifest: ModulePagesManifest = {
  id: "projects",
  routes: {
    "": ProjectsPage,
    "[id]": ProjectDetailPage,
  },
};
