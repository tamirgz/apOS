import { CheckSquare } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const tasksManifest: ModuleManifest = {
  id: "tasks",
  title: "Tasks",
  icon: CheckSquare,
  accent: "var(--color-ion)",
  nav: { order: 10 },
  searchable: true,
  commands: [
    {
      id: "tasks.open",
      title: "Go to Tasks",
      keywords: ["tasks", "todo", "board"],
      href: "/m/tasks",
    },
    {
      id: "tasks.new",
      title: "New task",
      keywords: ["task", "add", "create", "todo"],
      href: "/m/tasks",
    },
  ],
};
