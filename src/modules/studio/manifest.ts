import { Workflow } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const studioManifest: ModuleManifest = {
  id: "studio",
  title: "Flows",
  icon: Workflow,
  accent: "var(--color-plasma)",
  nav: { order: 72, group: "Automation" },
  commands: [
    {
      id: "studio.open",
      title: "Open Flows",
      keywords: [
        "studio",
        "flows",
        "flow",
        "routine",
        "canvas",
        "builder",
        "multi-agent",
        "orchestration",
        "automation",
        "workflow",
      ],
      href: "/m/studio",
    },
    {
      id: "studio.new",
      title: "New flow",
      keywords: ["new flow", "create flow", "build flow", "studio"],
      href: "/m/studio?new=1",
    },
  ],
};
