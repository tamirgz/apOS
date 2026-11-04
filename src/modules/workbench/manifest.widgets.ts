import type { ModuleWidgets } from "@/core/modules/types.server";
import { countActiveTasks } from "./queries";
import { WorkbenchWidget } from "./widgets/WorkbenchWidget";

export const workbenchWidgets: ModuleWidgets = {
  id: "workbench",
  widgets: [
    {
      id: "workbench-active",
      title: "Runs",
      size: "sm",
      component: WorkbenchWidget,
      // An empty Runs card only said "nothing delegated".
      hideWhen: async () => {
        const c = await countActiveTasks();
        return c.running + c.queued + c.review === 0;
      },
    },
  ],
};
