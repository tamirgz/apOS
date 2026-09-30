import { Hammer } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const workbenchManifest: ModuleManifest = {
  id: "workbench",
  title: "Runs",
  icon: Hammer,
  accent: "var(--color-plasma)",
  nav: { order: 70, group: "Automation" },
  searchable: true,
  commands: [
    {
      id: "workbench.open",
      title: "Go to Runs",
      keywords: ["runs", "workbench", "tasks", "delegate", "agent", "run", "jobs"],
      href: "/m/workbench",
    },
    {
      id: "workbench.new",
      title: "Delegate a task",
      keywords: ["delegate", "do", "research", "code", "fix", "background"],
      href: "/m/workbench",
    },
  ],
};
