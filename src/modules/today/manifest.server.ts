import type { ModuleServerManifest } from "@/core/modules/types.server";
import { attentionItems } from "./schema";
import { todayTools } from "./tools";
import { todayJobs } from "./jobs";
import { TodayPage } from "./pages/TodayPage";
import { QueuePage } from "./pages/QueuePage";
import { PlanPage } from "./pages/PlanPage";
import { NeedsYouWidget } from "./widgets/NeedsYouWidget";

export const todayServerManifest: ModuleServerManifest = {
  id: "today",
  routes: {
    "": TodayPage,
    queue: QueuePage,
    // The Plan screen: /m/today/plan is today, /m/today/plan/YYYY-MM-DD another day.
    plan: PlanPage,
    "plan/[id]": PlanPage,
  },
  widgets: [
    {
      id: "today-focus",
      title: "Needs you",
      size: "md",
      component: NeedsYouWidget,
      priority: 1,
      span: 2,
      href: "/m/today/queue",
    },
  ],
  schema: { attentionItems },
  aiTools: todayTools,
  // The morning plan is now the DETERMINISTIC `today.plan` job (see ./planner),
  // not an LLM agent — a local model kept "succeeding" without ever calling
  // attention.raise, leaving "Needs you" silently empty. No agent template here.
  agentTemplates: [],
  jobs: todayJobs,
};
