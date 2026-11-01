import type { ModuleServerManifest } from "@/core/modules/types.server";
import {
  cycles,
  milestoneCapabilities,
  milestoneContent,
  milestones,
  taskActivity,
  taskAttachments,
  taskLinks,
  taskRelations,
  tasks,
  workCounters,
  workViews,
} from "./schema";
import { attachmentTools } from "./attachment-tools";
import { milestoneTools } from "./milestone-tools";
import { planningTools } from "./planning-tools";
import { taskTools } from "./tools";
import { workJobs } from "./jobs";
import { TasksPage } from "./pages/TasksPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";

export const tasksServerManifest: ModuleServerManifest = {
  id: "tasks",
  routes: {
    "": TasksPage,
    "[id]": TaskDetailPage,
  },
  widgets: [],
  schema: { tasks, workCounters, taskActivity, taskAttachments, cycles, taskRelations, taskLinks, workViews, milestones, milestoneCapabilities, milestoneContent },
  aiTools: [...taskTools, ...attachmentTools, ...planningTools, ...milestoneTools],
  jobs: workJobs,
  agentTemplates: [
    {
      id: "task-triage",
      name: "Task triage",
      description:
        "Reviews open tasks daily, flags stale or overdue ones by raising their priority.",
      defaultPrompt: [
        "Review my slipping work with tasks.list {slipping: true, limit: 30} — items untouched for 7+ days that are past due or sitting in doing/review. Each has a short `ref` ('t3') and an identifier (KEY-12); use either, never an id. Use ledger.has / ledger.mark so you never re-flag an item you already flagged.",
        "For a past-due item in backlog or todo, choose ONE: if it still matters, raise its priority with tasks.update {priority: 'high'}; if it is clearly not committed any more, move it with tasks.setStatus {status: 'backlog'}. 'backlog' is the ONLY status you may set. Leave a one-line tasks.comment saying why.",
        "Never set an item done or cancelled, and never change an item in doing or review — someone is working on it. Name those in your summary instead.",
        "Then summarize in a few lines what most needs attention today. If nothing is slipping, say so — that is a good result.",
      ].join("\n"),
      defaultTools: ["tasks.list", "tasks.setStatus", "tasks.update", "tasks.comment"],
      defaultSchedule: "0 8 * * *",
      // Free and local, like the rest of the daily fleet (2026-11 agent eval).
      defaultProvider: "ollama",
      defaultModel: "qwen3.5:35b-a3b-coding-nvfp4-32k",
      defaultFallbackModel: "qwen3-coder:30b",
    },
  ],
};
