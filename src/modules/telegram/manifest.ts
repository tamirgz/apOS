import { Send } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const telegramManifest: ModuleManifest = {
  id: "telegram",
  title: "Telegram",
  icon: Send,
  accent: "var(--color-ion)",
  nav: { order: 60, group: "Sources" },
  searchable: true, // readable in-app (no ↗)
  commands: [
    {
      id: "telegram.open",
      title: "Go to Telegram sources",
      keywords: ["telegram", "channel", "source", "feed", "posts"],
      href: "/m/telegram",
    },
  ],
};
