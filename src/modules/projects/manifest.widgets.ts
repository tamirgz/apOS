import type { ModuleWidgets } from "@/core/modules/types.server";
import { ActiveProjectsWidget } from "./widgets/ActiveProjectsWidget";

export const projectsWidgets: ModuleWidgets = {
  id: "projects",
  widgets: [
    {
      id: "active-projects",
      title: "Active projects",
      size: "sm",
      component: ActiveProjectsWidget,
    },
  ],
};
