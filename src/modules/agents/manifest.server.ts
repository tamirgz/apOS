import type { ModuleServerManifest } from "@/core/modules/types.server";
import { externalReports } from "./schema";
import { externalReportJobs } from "./external";
import { slackIntakeJobs } from "./slack-intake";
import { memoryMaintenanceJobs } from "./memory-maintenance";
import { memoryDistillJobs } from "./memory-distill";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentDetailPage } from "./pages/AgentDetailPage";
import { AgentModelsPage } from "./pages/AgentModelsPage";
import { AgentActivityWidget } from "./widgets/AgentActivityWidget";

export const agentsServerManifest: ModuleServerManifest = {
  id: "agents",
  routes: {
    "": AgentsPage,
    models: AgentModelsPage,
    "[id]": AgentDetailPage,
  },
  widgets: [
    {
      id: "agent-activity",
      title: "Agent activity",
      size: "md",
      component: AgentActivityWidget,
    },
  ],
  // Core owns agents/agent_runs; this module owns external_reports.
  schema: { externalReports },
  aiTools: [],
  jobs: [
    ...externalReportJobs,
    ...slackIntakeJobs,
    ...memoryMaintenanceJobs,
    ...memoryDistillJobs,
  ],
  agentTemplates: [
    {
      id: "memory-consolidation",
      name: "Memory consolidation",
      description:
        "Weekly: reviews tasks and projects, then rewrites the active_projects memory block so every AI call starts from the projects' real state. Never writes the user's focus or priorities.",
      defaultPrompt: [
        "Consolidate the user's WORKING MEMORY — the active_projects block injected into EVERY AI call. Keep it tight, accurate, current.",
        "Follow these steps IN ORDER. Read each source ONCE — never re-read. Do NOT call memory.review or memory.recall; you do not need them. The WRITES are the point — never stop before both are done.",
        "1. ledger.has for this ISO week (e.g. 2026-W33). If it is already marked, STOP — done.",
        "2. projects.list, then tasks.list — read each ONCE. That is your complete picture.",
        "3. memory.update 'active_projects' — ONE compressed line per ACTIVE project: name — state — its top open item (or 'no open items'). Facts from the data only: never guess priorities, focus, plans or deadlines. Terse; no filler. (REQUIRED.)",
        "4. ledger.mark the ISO week. Only now are you done — STOP. Do NOT touch other memory blocks — current_focus, who_i_am and preferences are the user's own.",
        "You are NOT finished until memory.update AND ledger.mark have run.",
      ].join("\n"),
      defaultTools: [
        "tasks.list",
        "projects.list",
        "knowledge.search",
        "memory.review",
        "memory.update",
      ],
      defaultSchedule: "0 20 * * 6", // Saturday 20:00 — before the Sun–Thu week starts
      // Memory work runs on a FREE LOCAL model — periodic, must never bill.
      // The MLX abliterated-35B wins on TEXT quality AND, once it can PLAN, on the
      // agentic loop: it earlier looped on reads and never wrote — the cause was
      // `reasoning_effort:"none"` forced on every MLX call. With light reasoning
      // enabled for agentic (tool) runs (see mlx.ts), it now reads each source
      // once, writes BOTH blocks and marks the ledger in ~7 calls — sharper output
      // than ollama and far leaner. Falls back to always-on Ollama if LM Studio is
      // down. Editable per-agent in Settings.
      defaultProvider: "mlx",
      defaultModel: "huihui-qwen3.6-35b-a3b-claude-4.7-opus-abliterated-mlx",
      defaultFallbackModel: "qwen3-coder:30b",
      defaultTurnBudget: 20,
    },
  ],
};
