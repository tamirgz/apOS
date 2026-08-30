import { BookOpen } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const obsidianManifest: ModuleManifest = {
  id: "vault",
  title: "Obsidian",
  icon: BookOpen,
  accent: "var(--color-violet)",
  nav: { order: 47, group: "Sources", external: true },
  searchable: true,
  commands: [
    {
      id: "vault.open",
      title: "Go to Obsidian",
      keywords: ["obsidian", "vault", "second brain", "notes"],
      href: "/m/vault",
    },
  ],
};
