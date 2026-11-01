import { and, eq, gte, isNull, notInArray, or } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import type { ModuleJob } from "@/core/modules/types.server";
import { attentionItems } from "@/modules/today/schema";
import { firstConferenceUrl } from "./meeting-url";
import { calendarEvents } from "./schema";

export const GOOGLE_KEYS = {
  clientId: "google_client_id",
  clientSecret: "google_client_secret",
  refreshToken: "google_refresh_token",
  /** The "Timeboxes" calendar apOS creates (Phase 1 PR 2) — excluded from the event import. */
  timeboxCalendarId: "timebox_calendar_id",
} as const;

export const GOOGLE_REDIRECT_PATH = "/api/google/callback";
// Calendar + Gmail, both read-only. Adding gmail here means the next Connect
// Google re-consent grants Gmail too (existing tokens keep working for
// calendar; the Gmail sync degrades gracefully until re-consent).
const SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly";
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 180;

/** Google's standard event palette (colors.event from the API), as fallback. */
const DEFAULT_EVENT_PALETTE: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
};

export async function isGoogleConnected(): Promise<boolean> {
  return !!(await getSetting(GOOGLE_KEYS.refreshToken));
}

export function buildAuthUrl(
  clientId: string,
  origin: string,
  state?: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: origin + GOOGLE_REDIRECT_PATH,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    ...(state ? { state } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(
  code: string,
  origin: string,
): Promise<void> {
  const [clientId, clientSecret] = await Promise.all([
    getSetting(GOOGLE_KEYS.clientId),
    getSetting(GOOGLE_KEYS.clientSecret),
  ]);
  if (!clientId || !clientSecret) throw new Error("client id/secret not set");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: origin + GOOGLE_REDIRECT_PATH,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    refresh_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !data.refresh_token) {
    throw new Error(
      data.error_description ?? data.error ?? `token exchange → ${res.status}`,
    );
  }
  await setSetting(GOOGLE_KEYS.refreshToken, data.refresh_token);
  await sql.notify("google_sync", "connected");
}

/** Fresh Google access token from the stored refresh token — reused by Gmail. */
export async function accessToken(): Promise<string> {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    getSetting(GOOGLE_KEYS.clientId),
    getSetting(GOOGLE_KEYS.clientSecret),
    getSetting(GOOGLE_KEYS.refreshToken),
  ]);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("google not connected");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(`token refresh failed: ${data.error ?? res.status}`);
  }
  return data.access_token;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  /** "transparent" = Show as: Free. */
  transparency?: "opaque" | "transparent";
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  /** Legacy Meet field — still populated for Meet calls. */
  hangoutLink?: string;
  /** Modern conferencing block: Meet, Zoom, Teams… */
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  /** The event in Google Calendar's web UI. */
  htmlLink?: string;
  /** Who's invited — feeds the L3 people table. */
  attendees?: {
    email?: string;
    displayName?: string;
    self?: boolean;
    resource?: boolean;
    responseStatus?: string;
  }[];
}

/**
 * The join URL for an event. `hangoutLink` covers Meet; `conferenceData`
 * covers add-ons that register a conference solution. Zoom invites often do
 * neither and simply put the URL in `location`, so that is the last resort.
 * Measured on the live calendar: 31/72 events carry hangoutLink, and only 3
 * mention a link in the description — the description is not a substitute.
 */
function meetingUrlOf(ev: GoogleEvent): string | null {
  if (ev.hangoutLink) return ev.hangoutLink;
  const points = ev.conferenceData?.entryPoints ?? [];
  const video = points.find((p) => p.entryPointType === "video" && p.uri);
  return (
    video?.uri ??
    points.find((p) => p.uri)?.uri ??
    firstConferenceUrl(ev.location) ??
    null
  );
}

/** One entry of the user's calendar list (calendarList.list). */
interface GoogleCalendarEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  /** Shown in the Google Calendar UI — the calendars the user looks at. */
  selected?: boolean;
  backgroundColor?: string;
}

/** The calendars to import: every calendar visible in Google, primary first. */
async function listCalendars(headers: HeadersInit): Promise<GoogleCalendarEntry[]> {
  const out: GoogleCalendarEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      minAccessRole: "reader",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`calendarList.list → ${res.status}`);
    const data = (await res.json()) as {
      items?: GoogleCalendarEntry[];
      nextPageToken?: string;
    };
    out.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  // The Timeboxes calendar syncs into `timeboxes`, never into calendar_events —
  // otherwise every box would show twice.
  const timeboxCalendar = await getSetting(GOOGLE_KEYS.timeboxCalendarId);
  return out
    .filter((c) => (c.primary || c.selected) && c.id !== timeboxCalendar)
    .sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
}

/**
 * API-based sync of every calendar visible in Google. singleEvents=true makes
 * Google expand recurrences server-side; colorId gives the user's real event
 * colors. The same meeting can sit on two calendars with one event id — the
 * first calendar (primary) keeps it.
 */
export async function syncGoogle(
  log: (m: string) => void = () => {},
): Promise<{ synced: number } | null> {
  if (!(await isGoogleConnected())) return null;
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}` };

  // Live palette (fall back to the well-known one).
  let palette = DEFAULT_EVENT_PALETTE;
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/colors", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        event?: Record<string, { background: string }>;
      };
      if (data.event) {
        palette = Object.fromEntries(
          Object.entries(data.event).map(([k, v]) => [k, v.background]),
        );
      }
    }
  } catch {
    // fallback palette is fine
  }

  const timeMin = new Date(
    Date.now() - WINDOW_PAST_DAYS * 86_400_000,
  ).toISOString();
  const timeMax = new Date(
    Date.now() + WINDOW_FUTURE_DAYS * 86_400_000,
  ).toISOString();

  const calendars = await listCalendars(headers);
  const seenAll = new Set<string>();
  let synced = 0;
  let failed = 0;
  const fetched: string[] = [];

  for (const cal of calendars) {
    const seen: string[] = [];
    try {
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          singleEvents: "true",
          orderBy: "startTime",
          timeMin,
          timeMax,
          maxResults: "250",
          ...(pageToken ? { pageToken } : {}),
        });
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
          { headers, signal: AbortSignal.timeout(20_000) },
        );
        if (!res.ok) throw new Error(`events.list → ${res.status}`);
        const data = (await res.json()) as {
          items?: GoogleEvent[];
          nextPageToken?: string;
        };

        for (const ev of data.items ?? []) {
          if (ev.status === "cancelled") continue;
          const startRaw = ev.start?.dateTime ?? ev.start?.date;
          if (!startRaw) continue;
          const uid = `g:${ev.id}`;
          if (seenAll.has(uid)) continue; // already imported from an earlier calendar
          seenAll.add(uid);
          seen.push(uid);
          synced++;
          const fields = {
            title: ev.summary ?? "(untitled)",
            notes: ev.description?.slice(0, 2000) ?? null,
            location: ev.location ?? null,
            meetingUrl: meetingUrlOf(ev),
            sourceUrl: ev.htmlLink ?? null,
            startAt: new Date(startRaw),
            endAt: ev.end?.dateTime
              ? new Date(ev.end.dateTime)
              : ev.end?.date
                ? new Date(ev.end.date)
                : null,
            allDay: !ev.start?.dateTime,
            // Primary keeps the category default; other calendars show in their own color.
            color: ev.colorId
              ? (palette[ev.colorId] ?? null)
              : cal.primary
                ? null
                : (cal.backgroundColor ?? null),
            calendarId: cal.id,
            transparent: ev.transparency === "transparent",
            attendees: (ev.attendees ?? [])
              .filter((a) => a.email && !a.resource)
              .map((a) => ({
                email: a.email!.toLowerCase(),
                name: a.displayName,
                self: a.self,
                responseStatus: a.responseStatus,
              })),
          };
          await db
            .insert(calendarEvents)
            .values({ ...fields, source: "google", icsUid: uid })
            .onConflictDoUpdate({
              target: calendarEvents.icsUid,
              set: { ...fields, updatedAt: new Date() },
            });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    } catch (e) {
      // One unreadable calendar must not stop — or prune — the others.
      failed++;
      log(`google sync: calendar ${cal.summary ?? cal.id} failed: ${String(e)}`);
      continue;
    }

    if (seen.length > 0) fetched.push(cal.id);
  }

  // Prune vanished future events per calendar — only calendars whose own fetch
  // fully succeeded, so a failure elsewhere can never wipe their rows. Runs
  // after every calendar was read, so an event that moved to another calendar
  // is re-homed by the upsert above, not deleted and re-created.
  const all = [...seenAll];
  for (const calendarId of fetched) {
    await db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.source, "google"),
          eq(calendarEvents.calendarId, calendarId),
          gte(calendarEvents.startAt, new Date()),
          notInArray(calendarEvents.icsUid, all),
        ),
      );
  }

  if (seenAll.size > 0 && failed === 0) {
    // API mode supersedes ICS rows entirely.
    await db.delete(calendarEvents).where(eq(calendarEvents.source, "ics"));
    // Future rows from calendars no longer visible in Google, and rows written
    // before events remembered their calendar (null calendar_id).
    await db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.source, "google"),
          gte(calendarEvents.startAt, new Date()),
          or(
            isNull(calendarEvents.calendarId),
            notInArray(
              calendarEvents.calendarId,
              calendars.map((c) => c.id),
            ),
          ),
          notInArray(calendarEvents.icsUid, all),
        ),
      );
  }

  await sql.notify("calendar_changed", "google-synced");
  log(`google sync: ${synced} events from ${calendars.length - failed}/${calendars.length} calendars`);
  return { synced };
}

// Distinctive title so the card dedupes and can be auto-resolved on recovery.
const RECONNECT_TITLE = "Reconnect Google — Calendar & Gmail sync stopped";

export const googleJobs: ModuleJob[] = [
  {
    channel: "google_sync",
    schedule: "*/5 * * * *",
    handle: async () => {
      try {
        await syncGoogle(console.log);
        // Recovered — clear any standing "reconnect" nag.
        await db
          .update(attentionItems)
          .set({ status: "done", updatedAt: new Date() })
          .where(
            and(
              eq(attentionItems.title, RECONNECT_TITLE),
              eq(attentionItems.status, "open"),
            ),
          );
      } catch (e) {
        // A revoked/expired refresh token fails silently forever otherwise —
        // surface it as a "Needs you" card instead of a 5-minute log loop.
        if (/invalid_grant|token refresh failed/i.test(String(e))) {
          const [open] = await db
            .select({ id: attentionItems.id })
            .from(attentionItems)
            .where(
              and(
                eq(attentionItems.title, RECONNECT_TITLE),
                eq(attentionItems.status, "open"),
              ),
            )
            .limit(1);
          if (!open) {
            const { insertAttentionItem } = await import("@/modules/today/core");
            await insertAttentionItem({
              type: "do",
              title: RECONNECT_TITLE,
              body: "Google revoked or expired the token (invalid_grant). Reconnect in Settings → Integrations to resume Calendar & Gmail sync.",
              source: "system",
              urgency: 20,
              href: "/m/settings/connections",
            });
            console.log("google_sync: token invalid — raised a Reconnect Google card");
          }
          return; // handled — don't spam the error log
        }
        throw e; // other failures surface as before
      }
    },
  },
];
