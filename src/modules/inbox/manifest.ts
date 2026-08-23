import { Inbox } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const inboxManifest: ModuleManifest = {
  id: "inbox",
  title: "Inbox",
  icon: Inbox,
  accent: "var(--color-solar)",
  nav: { order: 5 },
  searchable: true,
  commands: [
    {
      id: "inbox.open",
      title: "Go to Inbox",
      keywords: ["inbox", "capture", "dump", "triage"],
      href: "/m/inbox",
    },
  ],
};
