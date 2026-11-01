import { getSetting, setSetting } from "@/core/app-settings";

/**
 * The user's timeboxing rules — when boxes may be placed and how full the
 * Draft-my-day fill may get. Stored as one JSON app setting; anything missing
 * falls back to the defaults the user chose (2026-11-01).
 */
export interface TimeboxSettings {
  /** Days that can hold boxes (Date#getDay values). */
  days: number[];
  /** Boxable hours, "HH:MM" local time. */
  start: string;
  end: string;
  /** Deep work goes here first. */
  focusStart: string;
  focusEnd: string;
  /** The work shutdown — Draft my day fills work boxes only up to here. */
  workEnd: string;
  /** Share of free time Draft my day may box (0–1). */
  draftCap: number;
}

export const TIMEBOX_DEFAULTS: TimeboxSettings = {
  days: [0, 1, 2, 3, 4, 5], // Sun–Fri; Saturday stays unboxed
  start: "09:00",
  end: "23:00",
  focusStart: "09:00",
  focusEnd: "12:00",
  workEnd: "18:00",
  draftCap: 0.75,
};

const KEY = "timebox_settings";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Keep only well-formed fields, so a bad stored value can't break planning. */
function clean(raw: Partial<TimeboxSettings>): Partial<TimeboxSettings> {
  const out: Partial<TimeboxSettings> = {};
  if (Array.isArray(raw.days) && raw.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    out.days = [...new Set(raw.days)].sort();
  }
  for (const k of ["start", "end", "focusStart", "focusEnd", "workEnd"] as const) {
    if (typeof raw[k] === "string" && HHMM.test(raw[k])) out[k] = raw[k];
  }
  if (typeof raw.draftCap === "number" && raw.draftCap > 0 && raw.draftCap <= 1) {
    out.draftCap = raw.draftCap;
  }
  return out;
}

export async function getTimeboxSettings(): Promise<TimeboxSettings> {
  const raw = await getSetting(KEY);
  if (!raw) return TIMEBOX_DEFAULTS;
  try {
    return { ...TIMEBOX_DEFAULTS, ...clean(JSON.parse(raw)) };
  } catch {
    return TIMEBOX_DEFAULTS;
  }
}

export async function saveTimeboxSettings(patch: Partial<TimeboxSettings>): Promise<TimeboxSettings> {
  const next = { ...(await getTimeboxSettings()), ...clean(patch) };
  await setSetting(KEY, JSON.stringify(next));
  return next;
}
