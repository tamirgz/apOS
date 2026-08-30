import { Hammer } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const workbenchManifest: ModuleManifest = {
  id: "workbench",
  title: "Workbench",
  icon: Hammer,
  accent: "var(--color-plasma)",
  nav: { order: 16 },
  searchable: true,
  commands: [
    {
      id: "workbench.open",
      title: "Go to Workbench",
      keywords: ["workbench", "tasks", "delegate", "agent", "run", "jobs"],
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
