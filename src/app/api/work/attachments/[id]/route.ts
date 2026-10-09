import { db } from "@/core/db/client";
import { getAttachment, isActiveType, readAttachment } from "@/modules/tasks/attachments";

/**
 * A work-item attachment's bytes. Images, PDFs and text open inline; SVG/HTML
 * (active content — stored XSS if rendered same-origin) and `?download=1`
 * always download, under the original name.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getAttachment(db, id);
  if (!row) return new Response("not found", { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await readAttachment(row);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "unreadable", { status: 500 });
  }
  const active = isActiveType(row.contentType);
  const download = active || new URL(req.url).searchParams.has("download");
  // Text types render as plain text in the browser — never as markup.
  const type = active ? "application/octet-stream" : row.contentType.startsWith("text/") ? `${row.contentType}; charset=utf-8` : row.contentType;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "X-Content-Type-Options": "nosniff",
      // Immutable: an id's bytes never change (a new version is a new id).
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
