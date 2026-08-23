import { NotebookPen } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const notesManifest: ModuleManifest = {
  id: "notes",
  title: "Notes",
  icon: NotebookPen,
  accent: "var(--color-violet)",
  nav: { order: 30 },
  searchable: true,
  commands: [
    {
      id: "notes.open",
      title: "Go to Notes",
      keywords: ["notes", "markdown", "write", "logbook"],
      href: "/m/notes",
    },
    {
      id: "notes.new",
      title: "New note",
      keywords: ["note", "new", "create", "write"],
      href: "/m/notes",
    },
  ],
};
