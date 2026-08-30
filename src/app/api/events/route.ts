import postgres from "postgres";

export const dynamic = "force-dynamic";

const url =
  process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";

/**
 * SSE stream of Postgres NOTIFY events (agent_runs, agents_changed,
 * knowledge_changed). The worker NOTIFYs on every status transition; the UI
 * invalidates queries on message.
 *
 * ONE shared LISTEN connection serves every open tab — the old
 * connection-per-request design meant a handful of tabs (plus dev HMR reloads)
 * could exhaust the Postgres connection budget. Subscribers fan out in-process;
 * postgres.js re-subscribes the shared connection on reconnect.
 */
const CHANNELS = [
  "agent_runs",
  "agents_changed",
  "knowledge_changed",
  "notifications",
  "calendar_changed",
  "inbox_changed",
  "approvals_changed",
  "obsidian_changed",
  "external_reports",
  "ideas_changed",
  "embeddings_updated",
  "attention_changed",
  "project_files_changed",
  "projects_changed",
  "workbench_changed",
  "routines_changed",
  "telegram_changed",
  "flow_runs",
  "flows_changed",
] as const;

type Subscriber = (channel: string, payload: string) => void;

interface SseHub {
  subscribers: Set<Subscriber>;
  ready: Promise<void> | null;
}

// globalThis-cached so dev HMR reuses the connection instead of leaking one
// per reload (same pattern as the db client).
const g = globalThis as unknown as { __aiosSseHub?: SseHub };
const hub: SseHub = (g.__aiosSseHub ??= { subscribers: new Set(), ready: null });

function ensureListener(): Promise<void> {
  if (hub.ready) return hub.ready;
  hub.ready = (async () => {
    const listener = postgres(url, {
      max: 1,
      connection: { application_name: "aios-web-sse" },
    });
    for (const channel of CHANNELS) {
      await listener.listen(channel, (payload) => {
        for (const s of hub.subscribers) s(channel, payload ?? "");
      });
    }
  })().catch((e) => {
    hub.ready = null; // let the next request retry the connection
    throw e;
  });
  return hub.ready;
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Register cleanup BEFORE any await: AbortSignal fires "abort" only once,
      // and a client that disconnects during setup would otherwise leak its
      // subscriber + keepalive forever.
      let closed = false;
      const send: Subscriber = (channel, payload) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ channel, payload })}\n\n`),
          );
        } catch {
          cleanup(); // stream already closed
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        hub.subscribers.delete(send);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 25_000);
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) {
        cleanup();
        return;
      }

      try {
        await ensureListener();
      } catch {
        cleanup();
        return;
      }
      if (closed) return;
      hub.subscribers.add(send);
      send("hello", "connected");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
