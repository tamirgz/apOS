/**
 * Agent/MCP tools for work-item attachments (see attachments.ts). Files are
 * targeted by the item's ref/identifier on the way in and by attachment id
 * on the way out.
 */
import { z } from "zod";
import type { AiToolDef } from "@/core/modules/types.server";
import {
  ACCEPTED_EXTENSIONS,
  addAttachment,
  attachmentMeta,
  deleteAttachment,
  getAttachment,
  INLINE_TEXT_BYTES,
  isTextType,
  listAttachments,
  readAttachment,
  saveAttachmentTo,
} from "./attachments";
import { ATTACHMENT_KINDS } from "./schema";
import { actorOf, fileInput, loadFile, resolveTask } from "./tools";

const errorOf = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

export const attachmentTools: AiToolDef[] = [
  {
    name: "tasks.attach",
    description:
      `Attach a file (screenshot, log, findings, brief, evidence, harness output) to a work item — stored durably, deduplicated, kept forever (deletes are soft). Give exactly one of \`path\` (a file on this Mac: the apOS MCP server runs locally and reads it) or \`contentBase64\`. Re-using a name adds a new version and keeps the old one. Limits: 25 MB per file, 500 MB per project; types ${ACCEPTED_EXTENSIONS} (the last extension counts, so Board.dc.html is HTML; source files are stored as plain text). Zips are stored as-is, never unpacked.`,
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
      ...fileInput,
      contentType: z.string().optional().describe("Ignored — the type comes from the name's extension"),
      commentId: z.string().optional().describe("Link the file to this comment (commentId from tasks.get / tasks.comment)"),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      const f = await loadFile(input);
      if ("error" in f) return f;
      try {
        const a = await addAttachment(ctx.db, {
          taskId: t.id,
          ...f,
          kind: input.kind,
          caption: input.caption,
          commentId: input.commentId,
          actor: actorOf(ctx),
        });
        const m = attachmentMeta(a);
        return { id: m.id, name: m.name, version: m.version, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url };
      } catch (e) {
        return errorOf(e);
      }
    },
  },
  {
    name: "tasks.attachments",
    description: "List a work item's attachments — metadata only (id, name, version, kind, size, sha256, comment link, who/when). Fetch bytes with attachments.get.",
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
      kind: z.enum(ATTACHMENT_KINDS).optional(),
      includeDeleted: z.boolean().default(false),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      const rows = await listAttachments(ctx.db, t.id, { kind: input.kind, includeDeleted: input.includeDeleted });
      return { attachments: rows.map(attachmentMeta) };
    },
  },
  {
    name: "attachments.get",
    description: `Fetch one attachment by id (any version). Text files up to ${INLINE_TEXT_BYTES / 1024} KB come back inline; larger or binary files are written to \`saveTo\` (an absolute folder; default ~/.aios/downloads) and the saved path is returned. An existing file is never overwritten.`,
    input: z.object({
      id: z.string().describe("Attachment id"),
      saveTo: z.string().optional().describe("Absolute folder to save into"),
    }),
    async execute(input, ctx) {
      const a = await getAttachment(ctx.db, input.id);
      if (!a) return { error: `No attachment ${input.id}` };
      try {
        const meta = attachmentMeta(a);
        if (!input.saveTo && isTextType(a.contentType) && a.sizeBytes <= INLINE_TEXT_BYTES) {
          return { ...meta, content: (await readAttachment(a)).toString("utf8") };
        }
        return { ...meta, savedTo: await saveAttachmentTo(a, input.saveTo) };
      } catch (e) {
        return errorOf(e);
      }
    },
  },
  {
    name: "attachments.delete",
    description: "Hide an attachment (soft delete — the bytes are kept, the delete shows in the item's activity, and tasks.attachments with includeDeleted still lists it).",
    input: z.object({ id: z.string().describe("Attachment id") }),
    async execute(input, ctx) {
      try {
        const a = await deleteAttachment(ctx.db, input.id, actorOf(ctx));
        return { deleted: true, id: a.id, name: a.name, version: a.version };
      } catch (e) {
        return errorOf(e);
      }
    },
  },
];
