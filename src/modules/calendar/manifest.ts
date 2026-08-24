import { CalendarDays } from "lucide-react";
import type { ModuleManifest } from "@/core/modules/types";

export const calendarManifest: ModuleManifest = {
  id: "calendar",
  title: "Calendar",
  icon: CalendarDays,
  accent: "var(--color-plasma)",
  nav: { order: 15 },
  searchable: true,
  commands: [
    {
      id: "calendar.open",
      title: "Go to Calendar",
      keywords: ["calendar", "agenda", "events", "schedule", "today"],
      href: "/m/calendar",
    },
    {
      id: "calendar.new",
      title: "New event",
      keywords: ["event", "meeting", "schedule", "add"],
      href: "/m/calendar",
    },
  ],
};
