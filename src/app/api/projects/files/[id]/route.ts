import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { projectFiles } from "@/modules/projects/schema";

/** Streams an attached file's raw bytes back — the "view/download" link for search hits and the project's file list. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // A non-uuid segment would otherwise become a Postgres cast error → 500.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  const [row] = await db
    .select({
      filename: projectFiles.filename,
      mimeType: projectFiles.mimeType,
      content: projectFiles.content,
    })
    .from(projectFiles)
    .where(eq(projectFiles.id, id));

  if (!row) return new Response("not found", { status: 404 });

  // Active content (HTML/SVG/XML/JS) served inline same-origin would execute as
  // stored XSS against the app — force those to download as opaque bytes.
  const mime = row.mimeType || "application/octet-stream";
  const active = /html|svg|xml|javascript/i.test(mime);
  return new Response(new Uint8Array(row.content), {
    headers: {
      "Content-Type": active ? "application/octet-stream" : mime,
      "Content-Disposition": `${active ? "attachment" : "inline"}; filename="${encodeURIComponent(row.filename)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
