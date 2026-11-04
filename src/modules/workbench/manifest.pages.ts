import type { ModulePagesManifest } from "@/core/modules/types.server";
import { WorkbenchPage } from "./pages/WorkbenchPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { ExecutorsPage } from "./pages/ExecutorsPage";

export const workbenchPagesManifest: ModulePagesManifest = {
  id: "workbench",
  routes: {
    "": WorkbenchPage,
    executors: ExecutorsPage,
    "[id]": TaskDetailPage,
  },
};
