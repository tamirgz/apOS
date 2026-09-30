import { BookOpen } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const obsidianManifest: ModuleManifest = {
  id: "vault",
  title: "Vault",
  icon: BookOpen,
  accent: "var(--color-violet)",
  nav: { order: 46, group: "Library", external: true },
  searchable: true,
  commands: [
    {
      id: "vault.open",
      title: "Go to Vault",
      keywords: ["obsidian", "vault", "second brain", "notes"],
      href: "/m/vault",
    },
  ],
};
