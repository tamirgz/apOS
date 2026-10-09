/**
 * The user's work week: Sunday → Thursday, weekend Friday + Saturday (Israel).
 * Every "weekday" schedule, week key and calendar grid derives from here —
 * pure, no I/O, safe in the browser.
 */

/** First day of the week (0 = Sunday, as Date#getDay). */
export const WEEK_START = 0;

/** Days off (Date#getDay values). */
export const WEEKEND_DAYS: readonly number[] = [5, 6];

export const isWeekend = (d: Date) => WEEKEND_DAYS.includes(d.getDay());

/** Weekday names in grid order, starting at WEEK_START. */
export const WEEKDAY_LABELS = Array.from(
  { length: 7 },
  (_, i) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(WEEK_START + i) % 7],
);

/** Days from the week's first day back to `d` (0 when `d` starts the week). */
export const daysIntoWeek = (d: Date) => (d.getDay() - WEEK_START + 7) % 7;

/** ISO-8601 week label, e.g. "2026-W40" (Monday-start). */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((+t - +yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Week label for the Sunday-start work week containing `d`: the ISO week
 * shifted one day, so a Sunday keys with the Mon–Thu that follow it.
 */
export const workWeek = (d = new Date()) =>
  isoWeek(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
