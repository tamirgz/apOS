import { Workflow } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const studioManifest: ModuleManifest = {
  id: "studio",
  title: "Studio",
  icon: Workflow,
  accent: "var(--color-plasma)",
  nav: { order: 47 },
  commands: [
    {
      id: "studio.open",
      title: "Open Studio",
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
