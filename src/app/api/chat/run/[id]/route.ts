import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { chatRuns } from "@/core/db/schema/chat-runs";

export const runtime = "nodejs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a chat run's outcome — so a client that left mid-answer (navigated away)
 * can reclaim the result when it returns, instead of showing a stuck spinner.
 * The run itself keeps executing server-side detached from the browser.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("bad id", { status: 400 });
  const [row] = await db
    .select({
      status: chatRuns.status,
      result: chatRuns.result,
      error: chatRuns.error,
    })
    .from(chatRuns)
    .where(eq(chatRuns.id, id));
  if (!row) return new Response("not found", { status: 404 });
  return Response.json(row);
}
