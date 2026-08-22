import { BrainCircuit } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const knowledgeManifest: ModuleManifest = {
  id: "knowledge",
  title: "Knowledge",
  icon: BrainCircuit,
  accent: "var(--color-orchid)",
  nav: { order: 45 },
  searchable: true,
  commands: [
    {
      id: "knowledge.open",
      title: "Go to Knowledge",
      keywords: ["knowledge", "brain", "saved", "bookmarks", "capture"],
      href: "/m/knowledge",
    },
    {
      id: "knowledge.capture",
      title: "Capture knowledge",
      keywords: ["save", "paste", "capture", "repo", "link", "quote"],
      href: "/m/knowledge",
    },
  ],
};
