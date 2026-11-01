import { getSetting, SETTING_KEYS } from "@/core/app-settings";
import { getTimeboxSettings } from "@/modules/today/timebox-settings";
import { getAgenda } from "../agenda";
import { CalendarView } from "../components/CalendarView";
import { GOOGLE_SYNCED_AT, isGoogleConnected } from "../google";

export async function CalendarPage() {
  const now = new Date();
  // Window covers month navigation ±2 months.
  const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 3, 0);
  const [items, icsUrl, google, syncedAt, settings] = await Promise.all([
    getAgenda(from, to),
    getSetting(SETTING_KEYS.calendarIcsUrl),
    isGoogleConnected(),
    getSetting(GOOGLE_SYNCED_AT),
    getTimeboxSettings(),
  ]);
  return (
    <CalendarView
      items={items}
      settings={settings}
      sync={{ google, ics: !!icsUrl, syncedAt: syncedAt || null }}
    />
  );
}
