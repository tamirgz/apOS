import type { ModuleServerManifest } from "@/core/modules/types.server";
import { ideas } from "./schema";
import { ideaTools } from "./tools";
import { ideaJobs } from "./analyze";
import { IdeasPage } from "./pages/IdeasPage";
import { IdeaDetailPage } from "./pages/IdeaDetailPage";
import { IdeasPipelineWidget } from "./widgets/IdeasPipelineWidget";
import { IdeasStat } from "./widgets/IdeasStat";

export const ideasServerManifest: ModuleServerManifest = {
  id: "ideas",
  routes: {
    "": IdeasPage,
    "[id]": IdeaDetailPage,
  },
  widgets: [
    {
      id: "ideas-pipeline",
      title: "Idea pipeline",
      size: "sm",
      component: IdeasPipelineWidget,
      priority: 3,
      stat: IdeasStat,
    },
  ],
  schema: { ideas },
  aiTools: ideaTools,
  agentTemplates: [
    {
      id: "idea-reviewer",
      name: "Idea reviewer",
      description:
        "Weekly: reviews sparks and exploring ideas, picks the 1-2 most worth pushing forward, and nudges you via notification.",
      defaultPrompt:
        "Review my idea pipeline with ideas.list (stages spark and exploring) — each idea comes back with a short `ref` (e.g. 'i2'). Considering my memory context (who I am, current focus), pick the 1-2 ideas most worth advancing this week and say why in one sentence each; flag any that should be parked. Move an idea's stage with ideas.setStage, identifying it by its `ref` (never an id). Send the conclusion with notify.send (title 'Idea review'). Use ledger.mark with the ISO week so a same-week re-run is a no-op after checking ledger.has.",
      defaultTools: ["ideas.list", "ideas.setStage", "notify.send"],
      defaultSchedule: "0 9 * * 0", // Sunday 09:00 (work-week start)
    },
  ],
  jobs: ideaJobs,
};
