import { Orbit } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const orbitManifest: ModuleManifest = {
  id: "orbit",
  title: "Orbit",
  icon: Orbit,
  accent: "var(--color-ion)",
  nav: { order: 46 },
  commands: [
    {
      id: "orbit.open",
      title: "Open Orbit",
      keywords: [
        "orbit",
        "graph",
        "3d",
        "knowledge graph",
        "constellation",
        "connections",
        "vault",
        "map",
        "network",
      ],
      href: "/m/orbit",
    },
  ],
};
