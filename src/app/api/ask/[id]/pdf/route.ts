import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { askHistory } from "@/modules/ask/schema";
import { renderAskReportPdf } from "@/modules/ask/report";

export const runtime = "nodejs";

/** Streams a saved Ask answer as a structured PDF report (one-click download). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // A non-uuid segment would otherwise become a Postgres cast error → 500.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  const [row] = await db
    .select()
    .from(askHistory)
    .where(eq(askHistory.id, id));

  if (!row) return new Response("not found", { status: 404 });

  const pdf = await renderAskReportPdf({
    query: row.query,
    answer: row.answer,
    sources: row.sources,
    model: row.model,
    createdAt: row.createdAt,
  });

  const slug =
    row.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "answer";

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="aios-${slug}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
