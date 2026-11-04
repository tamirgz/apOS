import type { ModuleWidgets } from "@/core/modules/types.server";
import { NeedsYouWidget } from "./widgets/NeedsYouWidget";

export const todayWidgets: ModuleWidgets = {
  id: "today",
  widgets: [
    {
      id: "today-focus",
      title: "Needs you",
      size: "md",
      component: NeedsYouWidget,
      priority: 1,
      span: 3,
      href: "/m/today/queue",
    },
  ],
};
