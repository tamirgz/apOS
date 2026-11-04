import type { ModulePagesManifest } from "@/core/modules/types.server";
import { TasksPage } from "./pages/TasksPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";

export const tasksPagesManifest: ModulePagesManifest = {
  id: "tasks",
  routes: {
    "": TasksPage,
    "[id]": TaskDetailPage,
  },
};
