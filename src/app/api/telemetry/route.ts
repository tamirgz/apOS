import { db } from "@/core/db/client";
import { uiEvents } from "@/core/db/schema/ui-events";

const EVENT_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_BATCH = 50;

type Incoming = { event?: unknown; path?: unknown; entityRef?: unknown; meta?: unknown };

/**
 * Sink for the client usage beacon (navigator.sendBeacon → text/plain JSON).
 * Accepts one event or a small batch. Validated and size-capped so a runaway
 * client can't flood the table; always answers 204 — telemetry must never
 * surface an error to the UI.
 */
export async function POST(req: Request) {
  try {
    const raw = (await req.text()).slice(0, 32_000);
    const body = JSON.parse(raw) as Incoming | Incoming[];
    const list = (Array.isArray(body) ? body : [body]).slice(0, MAX_BATCH);
    const rows = list
      .filter((e) => typeof e.event === "string" && EVENT_RE.test(e.event))
      .map((e) => ({
        event: e.event as string,
        path: typeof e.path === "string" ? e.path.slice(0, 300) : null,
        entityRef: typeof e.entityRef === "string" ? e.entityRef.slice(0, 120) : null,
        meta:
          e.meta && typeof e.meta === "object" && JSON.stringify(e.meta).length < 2000
            ? (e.meta as Record<string, unknown>)
            : {},
      }));
    if (rows.length) await db.insert(uiEvents).values(rows);
  } catch {
    // swallow — a dropped usage event is fine, a failing page is not
  }
  return new Response(null, { status: 204 });
}
