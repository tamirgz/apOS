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

export const workbenchServerManifest: ModuleServerManifest = {
  id: "workbench",
  schema: { workbenchTasks, taskAttempts, attemptEvents, executors, routines },
  aiTools: workbenchTools,
  agentTemplates: [],
  jobs: [...workbenchJobs, ...routineJobs],
};
