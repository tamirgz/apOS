import type { ModuleServerManifest } from "@/core/modules/types.server";
import { workbenchJobs } from "./engine";
import { routineJobs } from "./routines";
import {
  attemptEvents,
  executors,
  routines,
  taskAttempts,
  workbenchTasks,
} from "./schema";
import { workbenchTools } from "./tools";
import { WorkbenchPage } from "./pages/WorkbenchPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { ExecutorsPage } from "./pages/ExecutorsPage";
import { WorkbenchWidget } from "./widgets/WorkbenchWidget";

export const workbenchServerManifest: ModuleServerManifest = {
  id: "workbench",
  routes: {
    "": WorkbenchPage,
    executors: ExecutorsPage,
    "[id]": TaskDetailPage,
  },
  widgets: [
    {
      id: "workbench-active",
      title: "Runs",
      size: "sm",
      component: WorkbenchWidget,
    },
  ],
  schema: { workbenchTasks, taskAttempts, attemptEvents, executors, routines },
  aiTools: workbenchTools,
  agentTemplates: [],
  jobs: [...workbenchJobs, ...routineJobs],
};
