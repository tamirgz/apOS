import { db } from "@/core/db/client";
import { recordUsage } from "@/core/usage";
import { addAttachment, attachmentMeta, MAX_FILE_BYTES } from "@/modules/tasks/attachments";
import { ATTACHMENT_KINDS, type AttachmentKind } from "@/modules/tasks/schema";

/** Upload from the item drawer (multipart: taskId, file, kind?, caption?, commentId?). */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const taskId = String(form?.get("taskId") ?? "");
  if (!form || !(file instanceof File) || !/^[0-9a-f-]{36}$/i.test(taskId)) {
    return Response.json({ error: "Send a file and the work item's id" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: `Not attached: "${file.name}" is over the 25 MB limit.` }, { status: 413 });
  }
  const kindIn = String(form.get("kind") ?? "other");
  const kind: AttachmentKind = (ATTACHMENT_KINDS as readonly string[]).includes(kindIn) ? (kindIn as AttachmentKind) : "other";
  try {
    const a = await addAttachment(db, {
      taskId,
      bytes: Buffer.from(await file.arrayBuffer()),
      name: file.name,
      kind,
      caption: (form.get("caption") as string | null) ?? null,
      commentId: (form.get("commentId") as string | null) || null,
      actor: "user",
    });
    recordUsage("work.attach", { entityRef: `tasks:${taskId}` });
    return Response.json(attachmentMeta(a));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
