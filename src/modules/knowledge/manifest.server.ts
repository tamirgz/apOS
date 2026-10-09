import type { ModuleServerManifest } from "@/core/modules/types.server";
import { knowledgeItems } from "./schema";
import { knowledgeTools } from "./tools";
import { knowledgeJobs } from "./pipeline";
import { KnowledgePage } from "./pages/KnowledgePage";
import { KnowledgeDetailPage } from "./pages/KnowledgeDetailPage";
import { RecentKnowledgeWidget } from "./widgets/RecentKnowledgeWidget";
import { KnowledgeStat } from "./widgets/KnowledgeStat";

export const knowledgeServerManifest: ModuleServerManifest = {
  id: "knowledge",
  routes: {
    "": KnowledgePage,
    "[id]": KnowledgeDetailPage,
  },
  widgets: [
    {
      id: "recent-knowledge",
      title: "Knowledge intake",
      size: "md",
      component: RecentKnowledgeWidget,
      priority: 3,
      stat: KnowledgeStat,
    },
  ],
  schema: { knowledgeItems },
  aiTools: knowledgeTools,
  agentTemplates: [
    {
      id: "knowledge-resurfacer",
      name: "Knowledge resurfacer",
      description:
        "Weekly: reviews recently saved knowledge, finds patterns across items, and surfaces connections you might have missed.",
      defaultPrompt:
        "Use knowledge.search with a few broad queries (recent topics, 'ai', 'business') to review the knowledge base. Identify patterns across recently saved items and surface 2-3 connections or themes worth acting on. Use ledger.has/ledger.mark with item ids to avoid re-reporting the same connections every week.",
      defaultTools: ["knowledge.search", "knowledge.read", "tasks.create"],
      defaultSchedule: "0 9 * * 0", // Sunday 09:00 (work-week start)
    },
  ],
  jobs: knowledgeJobs,
};
