import { FolderKanban } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const projectsManifest: ModuleManifest = {
  id: "projects",
  title: "Projects",
  icon: FolderKanban,
  accent: "var(--color-solar)",
  nav: { order: 20 },
  searchable: true,
  commands: [
    {
      id: "projects.open",
      title: "Go to Projects",
      keywords: ["projects", "project", "portfolio"],
      href: "/m/projects",
    },
    {
      id: "projects.new",
      title: "New project",
      keywords: ["project", "add", "create", "new"],
      href: "/m/projects",
    },
  ],
};
