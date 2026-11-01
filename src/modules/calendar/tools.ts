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
      "Get the user's personal calendar, day by day from the start of today (local time): events (apOS-local and synced Google Calendar) and the timeboxes the user planned (kind \"timebox\"). Times are local with their UTC offset; `day` is the local date. Work-item dates are not here — use the tasks tools for those.",
    input: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(7)
        .describe("How many days to cover, today included"),
    }),
    async execute(input) {
      // Whole local days: a UTC window cut "today" in two for anyone east of UTC.
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + input.days);
      const items = await getAgenda(from, new Date(to.getTime() - 1));
      return items.map((i) => ({
        kind: i.kind,
        title: i.title,
        day: localIso(i.at).slice(0, 10),
        at: i.allDay ? null : localIso(i.at),
        endAt: i.allDay || !i.endAt ? null : localIso(i.endAt),
        allDay: i.allDay,
        detail: i.detail,
      }));
    },
  },
];

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
/** "2026-11-02T09:30:00+02:00" — local wall time with its offset. */
function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}
