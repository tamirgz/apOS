import { Lightbulb } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const ideasManifest: ModuleManifest = {
  id: "ideas",
  title: "Ideas",
  icon: Lightbulb,
  accent: "var(--color-gold)",
  nav: { order: 40 },
  searchable: true,
  commands: [
    {
      id: "ideas.open",
      title: "Go to Ideas",
      keywords: ["ideas", "pipeline", "sparks", "brainstorm"],
      href: "/m/ideas",
    },
    {
      id: "ideas.new",
      title: "New idea",
      keywords: ["idea", "spark", "capture", "concept"],
      href: "/m/ideas",
    },
  ],
};
