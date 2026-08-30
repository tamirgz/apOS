import type { ModuleServerManifest } from "@/core/modules/types.server";
import { tasks } from "./schema";
import { taskTools } from "./tools";
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
  schema: { tasks },
  aiTools: taskTools,
  agentTemplates: [
    {
      id: "task-triage",
      name: "Task triage",
      description:
        "Reviews open tasks daily, flags stale or overdue ones by raising their priority.",
      defaultPrompt:
        "Review my open tasks with tasks.list — each task comes back with a short `ref` (e.g. 't3'). For any task that is clearly stale or overdue, move it with tasks.setStatus, identifying it by its `ref` (never an id). Then summarize what most needs attention today. Use ledger.has / ledger.mark to avoid re-flagging a task you already flagged.",
      defaultTools: ["tasks.list", "tasks.setStatus"],
      defaultSchedule: "0 8 * * *",
    },
  ],
};
