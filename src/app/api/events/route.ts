import postgres from "postgres";

export const dynamic = "force-dynamic";

const url =
  process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";

/**
 * SSE stream of Postgres NOTIFY events (agent_runs, agents_changed,
 * knowledge_changed). The worker NOTIFYs on every status transition; the UI
 * invalidates queries on message.
 */
export async function GET(req: Request) {
  const listener = postgres(url, { max: 1 });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Register cleanup BEFORE any await: AbortSignal fires "abort" only
      // once, and a client that disconnects during LISTEN setup would
      // otherwise leak this dedicated Postgres connection forever.
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        listener.end({ timeout: 1 }).catch(() => {});
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

      const send = (channel: string, payload: string) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ channel, payload })}\n\n`,
            ),
          );
        } catch {
          // stream already closed
        }
      };

      for (const channel of [
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
      ]) {
        if (closed) return;
        await listener.listen(channel, (payload) =>
          send(channel, payload ?? ""),
        );
      }
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
