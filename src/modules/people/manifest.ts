import { Users } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const peopleManifest: ModuleManifest = {
  id: "people",
  title: "People",
  icon: Users,
  accent: "var(--color-ion)",
  nav: { order: 25 },
  searchable: true, // right after Projects
  commands: [
    {
      id: "people.open",
      title: "Go to People",
      keywords: ["people", "contacts", "follow-up", "who"],
      href: "/m/people",
    },
  ],
};
