import { Sun } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const todayManifest: ModuleManifest = {
  id: "today",
  title: "Today",
  icon: Sun,
  accent: "var(--color-solar)",
  nav: { order: 5 }, // first working surface, above Inbox
  commands: [
    {
      id: "today.open",
      title: "Go to Today",
      keywords: ["today", "plan", "day", "needs you", "focus", "now"],
      href: "/m/today",
    },
    {
      id: "today.plan",
      title: "Plan my day (timebox)",
      keywords: ["plan", "timebox", "schedule", "day", "draft", "boxes"],
      href: "/m/today/plan",
    },
  ],
};
