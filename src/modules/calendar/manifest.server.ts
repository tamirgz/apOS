import type { ModuleServerManifest } from "@/core/modules/types.server";
import { calendarEvents } from "./schema";
import { calendarTools } from "./tools";
import { calendarJobs } from "./sync";
import { googleJobs } from "./google";

export const calendarServerManifest: ModuleServerManifest = {
  id: "calendar",
  schema: { calendarEvents },
  aiTools: calendarTools,
  agentTemplates: [
    {
      id: "daily-brief",
      name: "Daily brief",
      description:
        "Every morning: your unified agenda (Google events, task deadlines, publish dates) plus open-task summary, pushed to the bell and Slack.",
      defaultPrompt:
        "Build my morning brief. Use calendar.agenda (days: 1) for today's schedule and tasks.list (status: todo) for open work. Compose one concise brief: schedule first, then the 3 most important tasks. Send it with notify.send (title 'Morning brief', level 'info'). Use ledger.mark with today's date as itemKey so a re-run the same day is a no-op after checking ledger.has first.",
      defaultTools: ["calendar.agenda", "tasks.list", "notify.send"],
      defaultSchedule: "0 7 * * *",
    },
  ],
  jobs: [...calendarJobs, ...googleJobs],
};
