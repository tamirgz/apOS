import { CheckSquare } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const tasksManifest: ModuleManifest = {
  id: "tasks",
  title: "Work",
  icon: CheckSquare,
  accent: "var(--color-ion)",
  nav: { order: 10 },
  searchable: true,
  commands: [
    {
      id: "tasks.open",
      title: "Go to Work",
      keywords: ["work", "tasks", "todo", "board", "issues", "features"],
      href: "/m/tasks",
    },
    {
      id: "tasks.new",
      title: "New work item",
      keywords: ["task", "item", "issue", "add", "create", "todo"],
      href: "/m/tasks",
    },
  ],
};
