/**
 * Timebox ↔ Google sync against an in-memory fake of the Calendar API.
 *
 *   pnpm test:timebox
 *
 * Uses the real DB: its boxes are titled "ZZ test …" and deleted afterwards,
 * and the timebox app settings are restored. Refuses to run while real boxes
 * exist, because the sync pushes every non-draft box.
 */
import { and, eq, gte, like, not } from "drizzle-orm";
import { db } from "../src/core/db/client";
import { getSetting, setSetting } from "../src/core/app-settings";
import { attentionItems, timeboxes } from "../src/modules/today/schema";
import { syncTimeboxes } from "../src/modules/calendar/timebox-sync";

const SETTING_KEYS = ["timebox_calendar_id", "timebox_sync_token", "timebox_calendar_gone"];
const SCOPES =
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.app.created";

// ── the fake Google ──────────────────────────────────────────────────────────
type Ev = Record<string, any> & { id: string; etag: string; status: string; updated: string; seq: number };
const google = {
  calendars: new Set<string>(),
  events: new Map<string, Ev>(),
  seq: 0,
  calls: [] as string[],
  failInsert: false,
  /** Hold a calendar create until a second one arrives (or 1.5s) — makes the race deterministic. */
  holdCreate: false,
};
let releaseCreate: (() => void) | null = null;
let n = 0;
const stamp = (ev: Record<string, any> & { id: string; status: string }): Ev => ({
  ...ev,
  etag: `"e${++n}"`,
  updated: new Date().toISOString(),
  seq: ++google.seq,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  // Checked before the body is read: the token request body holds the real secrets.
  if (url.host === "oauth2.googleapis.com") return json({ access_token: "fake", scope: SCOPES });
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.host !== "www.googleapis.com") return realFetch(input, init);
  // Google takes time to answer; an instant fake would hide races.
  await new Promise((r) => setTimeout(r, 25));
  const path = url.pathname.replace("/calendar/v3", "");
  google.calls.push(`${method} ${path}`);
  if (path === "/calendars/primary") return json({ timeZone: "Asia/Jerusalem" });
  if (path === "/calendars" && method === "POST") {
    if (google.holdCreate) {
      if (releaseCreate) releaseCreate();
      else await new Promise<void>((r) => { releaseCreate = r; setTimeout(r, 1500); });
      releaseCreate = null;
    }
    google.calendars.add("cal-1");
    return json({ id: "cal-1", summary: body.summary });
  }
  const m = path.match(/^\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/);
  if (!m) return json({ error: "unknown" }, 400);
  const [, cal, eventId] = m;
  if (!google.calendars.has(decodeURIComponent(cal))) return json({ error: "notFound" }, 404);
  if (!path.includes("/events")) return json({ id: cal });
  if (method === "GET") {
    const since = Number(url.searchParams.get("syncToken") ?? 0);
    const items = [...google.events.values()].filter((e) => e.seq > since);
    return json({ items, nextSyncToken: String(google.seq) });
  }
  if (method === "POST") {
    if (google.failInsert) return json({ error: "backendError" }, 503);
    if (google.events.has(body.id)) return json({ error: "duplicate" }, 409);
    const ev = stamp({ ...body, status: "confirmed" });
    google.events.set(ev.id, ev);
    return json(ev);
  }
  const cur = google.events.get(eventId);
  if (!cur) return json({ error: "notFound" }, 404);
  if (method === "PATCH") {
    const ev = stamp({ ...cur, ...body, id: cur.id });
    google.events.set(ev.id, ev);
    return json(ev);
  }
  if (method === "DELETE") {
    google.events.set(eventId, stamp({ ...cur, status: "cancelled" }));
    return new Response(null, { status: 204 });
  }
  return json({ error: "unsupported" }, 400);
}) as typeof fetch;

/** The user editing in Google Calendar. */
function userEdits(id: string, patch: Record<string, unknown>) {
  const cur = google.events.get(id)!;
  google.events.set(id, stamp({ ...cur, ...patch }));
}

// ── harness ──────────────────────────────────────────────────────────────────
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const at = (h: number, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
};
const box = async (id: string) => (await db.select().from(timeboxes).where(eq(timeboxes.id, id)))[0];
const newBox = async (v: Partial<typeof timeboxes.$inferInsert>) =>
  (
    await db
      .insert(timeboxes)
      .values({ title: "ZZ test box", startAt: at(9), endAt: at(10), ...v })
      .returning()
  )[0];
const sync = () => syncTimeboxes(() => {});

const real = await db.select({ id: timeboxes.id }).from(timeboxes).where(not(like(timeboxes.title, "ZZ test%")));
if (real.length) {
  console.error(`refusing to run: ${real.length} real timebox(es) exist and would be pushed to the fake`);
  process.exit(1);
}
const saved = Object.fromEntries(await Promise.all(SETTING_KEYS.map(async (k) => [k, await getSetting(k)])));
const startedAt = new Date();

try {
  for (const k of SETTING_KEYS) await setSetting(k, "");

  // 1. Lock: planned boxes reach Google, drafts don't.
  const draft = await newBox({ title: "ZZ test draft", status: "draft" });
  const planned = await newBox({ title: "ZZ test deep", status: "planned", kind: "deep", endMode: "hard" });
  await sync();
  check("creates the Timeboxes calendar once", google.calendars.size === 1 && (await getSetting("timebox_calendar_id")) === "cal-1");
  const pb = await box(planned.id);
  const ev = google.events.get(pb.googleEventId ?? "");
  check("a planned box is pushed and marked synced", pb.syncState === "synced" && !!ev, pb);
  check(
    "the event carries the box id, kind colour, hard stop and a start popup",
    ev?.extendedProperties?.private?.aposBoxId === planned.id &&
      ev?.colorId === "9" &&
      ev?.description === "⏹ Hard stop" &&
      ev?.reminders?.overrides?.[0]?.minutes === 0,
    ev,
  );
  check("a draft box is never pushed", (await box(draft.id)).googleEventId === null && google.events.size === 1);

  // 2. Our own write coming back is not treated as a Google edit.
  const before = await box(planned.id);
  await sync();
  check("the echo of our push changes nothing", (await box(planned.id)).updatedAt.getTime() === before.updatedAt.getTime());
  check("a second sync creates no second calendar", google.calls.filter((c) => c === "POST /calendars").length === 1);

  // 3. Moved in Google → moved in apOS.
  userEdits(pb.googleEventId!, { start: { dateTime: at(14).toISOString() }, end: { dateTime: at(15, 30).toISOString() } });
  await sync();
  const moved = await box(planned.id);
  check("a move in Google moves the box", moved.startAt.getTime() === at(14).getTime() && moved.endAt.getTime() === at(15, 30).getTime(), moved);

  // 4. Created in Google → a new box.
  google.events.set("gnew1", stamp({ id: "gnew1", status: "confirmed", summary: "ZZ test from phone", start: { dateTime: at(19).toISOString() }, end: { dateTime: at(20).toISOString() } }));
  google.events.set("gallday", stamp({ id: "gallday", status: "confirmed", summary: "ZZ test all day", start: { date: "2026-12-01" }, end: { date: "2026-12-02" } }));
  await sync();
  const [fromGoogle] = await db.select().from(timeboxes).where(eq(timeboxes.googleEventId, "gnew1"));
  check("an event made in Google becomes a planned box", fromGoogle?.origin === "google" && fromGoogle.status === "planned" && fromGoogle.kind === "shallow", fromGoogle);
  check("an all-day event does not become a box", (await db.select().from(timeboxes).where(eq(timeboxes.googleEventId, "gallday"))).length === 0);

  // 5. Deleted in Google → dropped, kept as history.
  userEdits("gnew1", { status: "cancelled" });
  await sync();
  check("a delete in Google drops the box", (await box(fromGoogle.id)).status === "dropped");

  // 6. Dropped in apOS → deleted in Google.
  await db.update(timeboxes).set({ status: "dropped", syncState: "pending", updatedAt: new Date() }).where(eq(timeboxes.id, planned.id));
  await sync();
  check("dropping a box deletes its event", google.events.get(pb.googleEventId!)?.status === "cancelled" && (await box(planned.id)).syncState === "synced");

  // 7. A lost insert reply: the event exists, the box doesn't know → no duplicate.
  const lost = await newBox({ title: "ZZ test lost reply", status: "planned" });
  const lostId = lost.id.replaceAll("-", "");
  google.events.set(lostId, stamp({ id: lostId, status: "confirmed", summary: "ZZ test lost reply", extendedProperties: { private: { aposBoxId: lost.id } }, start: { dateTime: at(11).toISOString() }, end: { dateTime: at(12).toISOString() } }));
  await db.update(timeboxes).set({ syncState: "pending", updatedAt: new Date(Date.now() + 1000) }).where(eq(timeboxes.id, lost.id));
  await sync();
  check("a retried insert updates the existing event", (await box(lost.id)).googleEventId === lostId && [...google.events.keys()].filter((k) => k === lostId).length === 1);

  // 8. Last edit wins: a newer apOS edit beats an older Google one.
  const lb = await box(lost.id);
  userEdits(lostId, { summary: "ZZ test google title" });
  await db.update(timeboxes).set({ title: "ZZ test apos title", syncState: "pending", updatedAt: new Date(Date.now() + 5000) }).where(eq(timeboxes.id, lb.id));
  await sync();
  check("the newer apOS edit wins and is pushed", (await box(lb.id)).title === "ZZ test apos title" && google.events.get(lostId)?.summary === "ZZ test apos title");

  // 9. A failed push is marked and retried.
  google.failInsert = true;
  const flaky = await newBox({ title: "ZZ test flaky", status: "planned" });
  await sync();
  check("a failed push leaves sync_state=error", (await box(flaky.id)).syncState === "error");
  google.failInsert = false;
  await sync();
  check("the next sync retries it", (await box(flaky.id)).syncState === "synced");

  // 10. Two processes reaching an empty setting at once create ONE calendar.
  // A second module instance has its own in-process mutex, like another process.
  // The query string makes a fresh instance; a variable keeps tsc from resolving it.
  const racePath = "../src/modules/calendar/timebox-sync.ts?race";
  const other = (await import(racePath)) as typeof import("../src/modules/calendar/timebox-sync");
  const creates = () => google.calls.filter((c) => c === "POST /calendars").length;
  const createsBefore = creates();
  await setSetting("timebox_calendar_id", "");
  google.calendars.clear();
  google.holdCreate = true;
  await Promise.all([sync(), other.syncTimeboxes(() => {})]);
  google.holdCreate = false;
  check("two racing syncs create one calendar", creates() - createsBefore === 1, creates() - createsBefore);

  // 11. The calendar deleted in Google: a card, and no silent re-create.
  google.calendars.clear();
  await sync();
  await sync();
  check("a deleted calendar is not re-created", creates() - createsBefore === 1 && (await getSetting("timebox_calendar_gone")) === "cal-1");
  const cards = await db.select().from(attentionItems).where(and(eq(attentionItems.title, "Timeboxes calendar was deleted in Google"), eq(attentionItems.status, "open")));
  check("…and one card asks the user", cards.length === 1);
} finally {
  globalThis.fetch = realFetch;
  await db.delete(timeboxes).where(like(timeboxes.title, "ZZ test%"));
  // Only the card this run raised.
  await db
    .delete(attentionItems)
    .where(and(eq(attentionItems.title, "Timeboxes calendar was deleted in Google"), gte(attentionItems.createdAt, startedAt)));
  for (const k of SETTING_KEYS) await setSetting(k, saved[k] ?? "");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
