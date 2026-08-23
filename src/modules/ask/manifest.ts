import { Sparkles } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const askManifest: ModuleManifest = {
  id: "ask",
  title: "Ask",
  icon: Sparkles,
  accent: "var(--color-plasma)",
  nav: { order: 6 },
  searchable: true, // right after Today — it's a primary surface
  commands: [
    {
      id: "ask.open",
      title: "Ask your knowledge",
      keywords: ["ask", "question", "search", "answer", "notebook"],
      href: "/m/ask",
    },
  ],
};
