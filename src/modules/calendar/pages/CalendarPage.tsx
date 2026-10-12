import { getSetting, SETTING_KEYS } from "@/core/app-settings";
import { getAgenda } from "../agenda";
import { CalendarView } from "../components/CalendarView";

export async function CalendarPage() {
  const now = new Date();
  // Window covers month navigation ±2 months.
  const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 3, 0);
  const [items, icsUrl] = await Promise.all([
    getAgenda(from, to),
    getSetting(SETTING_KEYS.calendarIcsUrl),
  ]);
  return <CalendarView items={items} hasIcs={!!icsUrl} />;
}
