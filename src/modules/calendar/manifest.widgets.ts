import type { ModuleWidgets } from "@/core/modules/types.server";
import { NowWidget } from "./widgets/NowWidget";

export const calendarWidgets: ModuleWidgets = {
  id: "calendar",
  widgets: [
    {
      id: "now",
      title: "Now",
      size: "lg",
      component: NowWidget,
      priority: 1,
      span: 4,
      bare: true,
    },
  ],
};
