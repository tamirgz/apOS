import { NotebookText } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const notionManifest: ModuleManifest = {
  id: "notion",
  title: "Notion",
  icon: NotebookText,
  accent: "var(--color-ink-dim)",
  nav: { order: 46, group: "Sources", external: true },
  searchable: true,
  commands: [
    {
      id: "notion.open",
      title: "Go to Notion",
      keywords: ["notion", "wiki", "docs"],
      href: "/m/notion",
    },
  ],
};
