import type { ModuleServerManifest } from "@/core/modules/types.server";
import { taskActivity, tasks, workCounters } from "./schema";
import { taskTools } from "./tools";
import { workJobs } from "./jobs";
import { TasksPage } from "./pages/TasksPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { OpenTasksWidget } from "./widgets/OpenTasksWidget";
import { UpNextWidget } from "./widgets/UpNextWidget";
import { TaskLoadStat } from "./widgets/TaskLoadStat";

export const tasksServerManifest: ModuleServerManifest = {
  id: "tasks",
  routes: {
    "": TasksPage,
    "[id]": TaskDetailPage,
  },
  widgets: [
    {
      id: "open-tasks",
      title: "Task load",
      size: "sm",
      component: OpenTasksWidget,
      priority: 3,
      stat: TaskLoadStat,
    },
    {
      id: "up-next",
      title: "Up next",
      size: "md",
      component: UpNextWidget,
      priority: 1,
      span: 4,
    },
  ],
  schema: { tasks, workCounters, taskActivity },
  aiTools: taskTools,
  jobs: workJobs,
  agentTemplates: [
    {
      id: "task-triage",
      name: "Task triage",
      description:
        "Reviews open tasks daily, flags stale or overdue ones by raising their priority.",
      defaultPrompt:
        "Review my open work items with tasks.list — each comes back with a short `ref` (e.g. 't3') and an identifier (e.g. ETHOS-12). States are backlog → todo → doing → review → done (or cancelled). For an item that is clearly stale or overdue, raise its priority with tasks.update or move it with tasks.setStatus (backlog if it is not really committed), and leave a one-line tasks.comment saying why. Identify items by `ref` or identifier, never an id. Then summarize what most needs attention today. Use ledger.has / ledger.mark to avoid re-flagging an item you already flagged.",
      defaultTools: ["tasks.list", "tasks.setStatus", "tasks.update", "tasks.comment"],
      defaultSchedule: "0 8 * * *",
    },
  ],
};
