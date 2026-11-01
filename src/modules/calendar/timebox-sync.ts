import { and, sql as dsql, eq, inArray, ne, or } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import { attentionItems, timeboxes, type Timebox, type TimeboxKind } from "@/modules/today/schema";
import { GOOGLE_KEYS, googleToken } from "./google";

/**
 * Two-way sync between the `timeboxes` table and the "Timeboxes" calendar apOS
 * creates in Google (timeboxing Phase 1, PR 2).
 *
 *  - push: planned/done/pushed boxes are written to Google; dropped boxes are
 *    deleted there. Drafts never leave apOS, so the phone stays quiet while the
 *    user is still arranging the day.
 *  - pull: incremental (syncToken) read of the Timeboxes calendar. A move in
 *    Google moves the box, a delete drops it, a new event becomes a box.
 *
 * Writes need `calendar.app.created`, which only lets apOS touch calendars it
 * created. Until the user reconnects with that scope, the sync raises one card
 * and does nothing else.
 */

const API = "https://www.googleapis.com/calendar/v3";
const APP_CREATED_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const CALENDAR_NAME = "Timeboxes";
const KEYS = {
  syncToken: "timebox_sync_token",
  /** The id of a Timeboxes calendar the user deleted in Google — blocks re-creating it. */
  gone: "timebox_calendar_gone",
} as const;

const RECONNECT_TITLE = "Reconnect Google to enable Timeboxes";
const GONE_TITLE = "Timeboxes calendar was deleted in Google";

/** Google event colours per box kind (colorId from Google's event palette). */
const KIND_COLOR: Record<TimeboxKind, string> = {
  deep: "9", // blueberry
  shallow: "7", // peacock
  admin: "8", // graphite
  inbox: "5", // banana
  personal: "2", // sage
};

interface GEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  updated?: string;
  recurrence?: string[];
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/** A box's event id in Google: its uuid without dashes (valid base32hex), so a retried insert can't duplicate. */
const eventIdOf = (boxId: string) => boxId.replaceAll("-", "");

async function raiseOnce(title: string, body: string) {
  const [open] = await db
    .select({ id: attentionItems.id })
    .from(attentionItems)
    .where(and(eq(attentionItems.title, title), eq(attentionItems.status, "open")))
    .limit(1);
  if (open) return;
  const { insertAttentionItem } = await import("@/modules/today/core");
  await insertAttentionItem({
    type: "do",
    title,
    body,
    source: "system",
    urgency: 20,
    href: "/m/settings/connections",
  });
}

async function closeCard(title: string) {
  await db
    .update(attentionItems)
    .set({ status: "done", updatedAt: new Date() })
    .where(and(eq(attentionItems.title, title), eq(attentionItems.status, "open")));
}

async function gfetch(token: string, path: string, init?: RequestInit) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

/**
 * The Timeboxes calendar id, creating the calendar on first use. Never creates
 * a second one: if the stored calendar is gone, a card asks the user, and only
 * a fresh Connect Google (which clears the block) starts a new calendar.
 */
async function ensureCalendar(token: string, log: (m: string) => void): Promise<string | null> {
  const id = await getSetting(GOOGLE_KEYS.timeboxCalendarId);
  if (id) {
    const res = await gfetch(token, `/calendars/${encodeURIComponent(id)}`);
    if (res.ok) return id;
    if (res.status === 404 || res.status === 410) {
      await setSetting(KEYS.gone, id);
      await setSetting(GOOGLE_KEYS.timeboxCalendarId, "");
      await setSetting(KEYS.syncToken, "");
      log("timebox sync: the Timeboxes calendar is gone — not re-creating it");
    } else {
      throw new Error(`timebox calendar check → ${res.status}`);
    }
  }
  if (await getSetting(KEYS.gone)) {
    await raiseOnce(
      GONE_TITLE,
      "Your boxes no longer reach Google, so no phone reminders. apOS won't re-create the calendar on its own. To start a new one, Connect Google again in Settings → Connections.",
    );
    return null;
  }
  // Boxes are local-time; give the calendar the user's primary time zone.
  const primary = await gfetch(token, "/calendars/primary");
  const timeZone = primary.ok ? ((await primary.json()) as { timeZone?: string }).timeZone : undefined;
  const res = await gfetch(token, "/calendars", {
    method: "POST",
    body: JSON.stringify({ summary: CALENDAR_NAME, ...(timeZone ? { timeZone } : {}) }),
  });
  if (!res.ok) throw new Error(`create Timeboxes calendar → ${res.status}`);
  const created = (await res.json()) as { id: string };
  await setSetting(GOOGLE_KEYS.timeboxCalendarId, created.id);
  await setSetting(KEYS.syncToken, "");
  log("timebox sync: created the Timeboxes calendar");
  return created.id;
}

function eventBody(b: Timebox) {
  return {
    summary: b.title,
    description: b.endMode === "hard" ? "⏹ Hard stop" : "",
    start: { dateTime: b.startAt.toISOString() },
    end: { dateTime: b.endAt.toISOString() },
    colorId: KIND_COLOR[b.kind],
    transparency: "opaque",
    status: "confirmed",
    // One popup at the start — that's the phone notification.
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    extendedProperties: { private: { aposBoxId: b.id, aposKind: b.kind } },
  };
}

/** Write one box to Google. Returns the event's id and etag, or null once deleted. */
async function pushOne(token: string, cal: string, b: Timebox) {
  const base = `/calendars/${encodeURIComponent(cal)}/events`;
  const eventId = b.googleEventId ?? eventIdOf(b.id);
  if (b.status === "dropped") {
    if (b.googleEventId) {
      const res = await gfetch(token, `${base}/${eventId}`, { method: "DELETE" });
      // Already gone in Google is the same outcome.
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`delete → ${res.status}`);
    }
    return null;
  }
  let res = b.googleEventId
    ? await gfetch(token, `${base}/${eventId}`, { method: "PATCH", body: JSON.stringify(eventBody(b)) })
    : await gfetch(token, base, { method: "POST", body: JSON.stringify({ id: eventId, ...eventBody(b) }) });
  // An earlier insert landed but its reply was lost: the id exists, so update it.
  if (res.status === 409) {
    res = await gfetch(token, `${base}/${eventId}`, { method: "PATCH", body: JSON.stringify(eventBody(b)) });
  }
  if (!res.ok) throw new Error(`${b.googleEventId ? "update" : "insert"} → ${res.status}`);
  const ev = (await res.json()) as GEvent;
  return { id: ev.id, etag: ev.etag ?? null };
}

async function push(token: string, cal: string, log: (m: string) => void) {
  const due = await db
    .select()
    .from(timeboxes)
    .where(and(ne(timeboxes.status, "draft"), inArray(timeboxes.syncState, ["pending", "error"])));
  let ok = 0;
  let failed = 0;
  for (const b of due) {
    try {
      const out = await pushOne(token, cal, b);
      await db
        .update(timeboxes)
        .set({
          syncState: "synced",
          googleEventId: out?.id ?? b.googleEventId,
          googleEtag: out?.etag ?? null,
        })
        // Only if nothing changed the box while we were writing it. Postgres keeps
        // microseconds, a JS Date only milliseconds — compare at ms precision.
        .where(
          and(
            eq(timeboxes.id, b.id),
            dsql`date_trunc('milliseconds', ${timeboxes.updatedAt}) = ${b.updatedAt.toISOString()}`,
          ),
        );
      ok++;
    } catch (e) {
      failed++;
      if (b.syncState !== "error") log(`timebox push failed for ${b.id}: ${e}`);
      await db.update(timeboxes).set({ syncState: "error" }).where(eq(timeboxes.id, b.id));
    }
  }
  return { ok, failed };
}

const dateOf = (t?: { dateTime?: string }) => (t?.dateTime ? new Date(t.dateTime) : null);

async function applyEvent(ev: GEvent): Promise<"skip" | "moved" | "dropped" | "created"> {
  const boxId = ev.extendedProperties?.private?.aposBoxId;
  const [box] = await db
    .select()
    .from(timeboxes)
    .where(boxId ? or(eq(timeboxes.googleEventId, ev.id), eq(timeboxes.id, boxId)) : eq(timeboxes.googleEventId, ev.id))
    .limit(1);

  if (ev.status === "cancelled") {
    if (!box || box.status === "dropped") return "skip";
    await db
      .update(timeboxes)
      .set({ status: "dropped", syncState: "synced", googleEtag: null, updatedAt: new Date() })
      .where(eq(timeboxes.id, box.id));
    return "dropped";
  }

  const start = dateOf(ev.start);
  const end = dateOf(ev.end);
  // All-day and recurring events don't make sense as boxes.
  if (!start || !end || ev.recurrence) return "skip";

  if (!box) {
    await db.insert(timeboxes).values({
      title: ev.summary?.trim() || "(untitled)",
      startAt: start,
      endAt: end,
      kind: "shallow",
      status: "planned",
      origin: "google",
      googleEventId: ev.id,
      googleEtag: ev.etag ?? null,
      syncState: "synced",
    });
    return "created";
  }
  // Our own write coming back.
  if (ev.etag && ev.etag === box.googleEtag) return "skip";
  // Last edit wins: an unpushed apOS edit newer than Google's keeps its place.
  const googleAt = ev.updated ? new Date(ev.updated) : new Date();
  if (box.syncState !== "synced" && box.updatedAt > googleAt) return "skip";
  await db
    .update(timeboxes)
    .set({
      title: ev.summary?.trim() || box.title,
      startAt: start,
      endAt: end,
      googleEventId: ev.id,
      googleEtag: ev.etag ?? null,
      syncState: "synced",
      updatedAt: new Date(),
    })
    .where(eq(timeboxes.id, box.id));
  return "moved";
}

async function pull(token: string, cal: string) {
  const counts = { moved: 0, dropped: 0, created: 0 };
  let syncToken = (await getSetting(KEYS.syncToken)) || null;
  let pageToken: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ maxResults: "250", showDeleted: "true" });
    if (syncToken) params.set("syncToken", syncToken);
    if (pageToken) params.set("pageToken", pageToken);
    const res = await gfetch(token, `/calendars/${encodeURIComponent(cal)}/events?${params}`);
    // Google expired the token: forget it and read everything again.
    if (res.status === 410 && syncToken) {
      syncToken = null;
      pageToken = null;
      await setSetting(KEYS.syncToken, "");
      continue;
    }
    if (!res.ok) throw new Error(`timebox pull → ${res.status}`);
    const data = (await res.json()) as { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string };
    for (const ev of data.items ?? []) {
      const r = await applyEvent(ev);
      if (r !== "skip") counts[r]++;
    }
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      continue;
    }
    if (data.nextSyncToken) await setSetting(KEYS.syncToken, data.nextSyncToken);
    return counts;
  }
}

// The 5-minute calendar job and an on-change nudge can overlap; run one at a time.
let running: Promise<unknown> = Promise.resolve();

export function syncTimeboxes(log: (m: string) => void = () => {}) {
  const next = running.then(() => syncTimeboxesOnce(log));
  running = next.catch(() => {});
  return next;
}

async function syncTimeboxesOnce(log: (m: string) => void) {
  const { token, scopes } = await googleToken();
  if (!scopes.has(APP_CREATED_SCOPE)) {
    await raiseOnce(
      RECONNECT_TITLE,
      "Timeboxes need permission to write to a calendar apOS creates. Connect Google again in Settings → Connections; everything else keeps working until then.",
    );
    return { skipped: "scope" as const };
  }
  await closeCard(RECONNECT_TITLE);
  const cal = await ensureCalendar(token, log);
  if (!cal) return { skipped: "calendar-gone" as const };
  await closeCard(GONE_TITLE);
  // Pull first, so a move made in Google is seen before we write over it.
  const pulled = await pull(token, cal);
  const pushed = await push(token, cal, log);
  if (pulled.moved + pulled.dropped + pulled.created + pushed.ok + pushed.failed > 0) {
    log(
      `timebox sync: pushed ${pushed.ok}${pushed.failed ? ` (${pushed.failed} failed)` : ""}, ` +
        `from Google ${pulled.moved} moved, ${pulled.dropped} dropped, ${pulled.created} new`,
    );
    await sql.notify("calendar_changed", "timeboxes-synced");
  }
  return { pulled, pushed };
}

/** Ask the worker to sync now (after a box is locked, moved or dropped). */
export async function requestTimeboxSync() {
  await sql.notify("timebox_sync", "");
}
