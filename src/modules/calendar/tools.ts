import { z } from "zod";
import type { AiToolDef } from "@/core/modules/types.server";
import { getAgenda } from "./agenda";

/**
 * Calendar is READ-ONLY for agents. Writing to the calendar (creating, editing,
 * or cancelling events) is intentionally not exposed — the user reserves that.
 */
export const calendarTools: AiToolDef[] = [
  {
    name: "calendar.agenda",
    description:
      "Get the user's personal calendar: events (apOS-local and synced Google Calendar). Work-item dates are not here — use the tasks tools for those.",
    input: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(7)
        .describe("How many days ahead to look"),
    }),
    async execute(input) {
      const now = new Date();
      const items = await getAgenda(
        new Date(now.getTime() - 6 * 3600_000),
        new Date(now.getTime() + input.days * 86_400_000),
      );
      return items.map((i) => ({
        kind: i.kind,
        title: i.title,
        at: i.at,
        allDay: i.allDay,
        detail: i.detail,
      }));
    },
  },
];
