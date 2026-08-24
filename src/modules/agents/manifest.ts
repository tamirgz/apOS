import { Bot } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const agentsManifest: ModuleManifest = {
  id: "agents",
  title: "Agents",
  icon: Bot,
  accent: "var(--color-flare)",
  nav: { order: 50 },
  searchable: true,
  commands: [
    {
      id: "agents.open",
      title: "Go to Agents",
      keywords: ["agents", "automation", "runs", "schedule", "cron"],
      href: "/m/agents",
    },
    {
      id: "agents.new",
      title: "New agent",
      keywords: ["agent", "create", "automate"],
      href: "/m/agents",
    },
  ],
};
