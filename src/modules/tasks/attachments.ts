/**
 * Work-item attachments — durable files (screenshots, logs, findings, evidence)
 * on an item or one of its comments. Bytes live in the attachments folder
 * (AIOS_ATTACHMENTS_DIR, a Google-Drive-synced folder on this Mac), one
 * sub-folder per project, content-addressed (`<sha12>-<name>`) and shared by
 * every row of the project with the same sha256. Rows are immutable: the same
 * name again is version N+1, and deleting only hides the row (bytes stay).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { projects } from "@/modules/projects/schema";
import { taskActivity, taskAttachments, tasks, type AttachmentKind, type TaskAttachment } from "./schema";
import type { Actor } from "./core";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 500 * 1024 * 1024;
/** Text files up to this size come back inline from attachments.get. */
export const INLINE_TEXT_BYTES = 200 * 1024;

/** Accepted file types, by extension — the extension decides the served type. */
export const ATTACHMENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  zip: "application/zip",
};

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "application/json", "text/csv"]);
export const isTextType = (t: string) => TEXT_TYPES.has(t);
export const isImageType = (t: string) => /^image\/(png|jpeg|webp)$/.test(t);
/** Active content (SVG/HTML) is never rendered inline — always a download. */
export const isActiveType = (t: string) => /html|svg|xml|javascript/i.test(t);

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/** Read at call time — dotenv may load after module import. */
export function attachmentsRoot(): string {
  return process.env.AIOS_ATTACHMENTS_DIR?.trim() || join(homedir(), ".aios", "attachments");
}

const DOWNLOADS = () => join(homedir(), ".aios", "downloads");

export const attachmentUrl = (id: string) =>
  `${process.env.APP_BASE_URL?.trim() || "http://localhost:3777"}/api/work/attachments/${id}`;

/** A file/folder name safe on macOS and Drive: no separators or control chars. */
function safeName(s: string): string {
  const out = s.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return out.slice(0, 120) || "file";
}

export function typeOf(name: string): string | null {
  return ATTACHMENT_TYPES[extname(name).slice(1).toLowerCase()] ?? null;
}

// Local paths an agent must never lift into Drive, whatever their extension.
const DENIED_DIRS = [".ssh", ".aws", ".gnupg", ".docker", ".kube", "Keychains", join(".config", "gcloud")];
const DENIED_FILE = /credential|secret|token|password|\.env\b|id_[rd]sa|\.pem$|\.key$/i;

/** Read a local file for upload, or explain why not. */
export async function readLocalFile(path: string): Promise<{ bytes: Buffer; path: string } | { error: string }> {
  if (!isAbsolute(path)) return { error: `path must be absolute: ${path}` };
  const p = normalize(path);
  const parts = p.split(sep);
  if (DENIED_DIRS.some((d) => p.includes(`${sep}${d}${sep}`)) || DENIED_FILE.test(basename(p)) || parts.includes(".env")) {
    return { error: `Not attached: ${p} looks like a credential or secrets file.` };
  }
  const st = await stat(p).catch(() => null);
  if (!st) return { error: `No file at ${p} (the apOS MCP server reads paths on this Mac only)` };
  if (!st.isFile()) return { error: `${p} is not a file` };
  if (st.size > MAX_FILE_BYTES) return { error: `Not attached: ${basename(p)} is ${mb(st.size)} — the limit is ${mb(MAX_FILE_BYTES)} per file.` };
  return { bytes: await readFile(p), path: p };
}

export function decodeBase64(b64: string): Buffer | { error: string } {
  const clean = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return { error: "contentBase64 is not valid base64" };
  return Buffer.from(clean, "base64");
}

async function projectOf(db: Db, taskId: string) {
  const [t] = await db.select({ projectRef: tasks.projectRef }).from(tasks).where(eq(tasks.id, taskId));
  if (!t) return null;
  const projectId = t.projectRef?.startsWith("projects:") ? t.projectRef.slice(9) : null;
  if (!projectId) return { projectId: null, folder: "Unfiled" };
  // Keep a project's files in one folder even after a rename: reuse the folder
  // its first attachment went to.
  const [first] = await db
    .select({ storagePath: taskAttachments.storagePath })
    .from(taskAttachments)
    .where(eq(taskAttachments.projectId, projectId))
    .orderBy(asc(taskAttachments.createdAt))
    .limit(1);
  if (first) return { projectId, folder: first.storagePath.split("/")[0] };
  const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
  return { projectId, folder: safeName(p?.name ?? projectId) };
}

export type NewAttachment = {
  taskId: string;
  bytes: Buffer;
  name: string;
  kind: AttachmentKind;
  caption?: string | null;
  commentId?: string | null;
  sourcePath?: string | null;
  actor: Actor;
};

/** Validate, store the bytes (dedup per project), insert the row + activity. */
export async function addAttachment(db: Db, a: NewAttachment): Promise<TaskAttachment> {
  const name = safeName(a.name);
  const contentType = typeOf(name);
  if (!contentType) {
    throw new Error(`Not attached: "${name}" — accepted types are ${Object.keys(ATTACHMENT_TYPES).join(", ")}.`);
  }
  if (!a.bytes.length) throw new Error(`Not attached: "${name}" is empty.`);
  if (a.bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Not attached: "${name}" is ${mb(a.bytes.length)} — the limit is ${mb(MAX_FILE_BYTES)} per file.`);
  }
  const where = await projectOf(db, a.taskId);
  if (!where) throw new Error("work item not found");
  if (a.commentId) {
    const [c] = await db
      .select({ id: taskActivity.id })
      .from(taskActivity)
      .where(and(eq(taskActivity.id, a.commentId), eq(taskActivity.taskId, a.taskId), eq(taskActivity.kind, "comment")));
    if (!c) throw new Error(`No comment ${a.commentId} on this work item.`);
  }

  const sha256 = createHash("sha256").update(a.bytes).digest("hex");
  const scope = where.projectId ? eq(taskAttachments.projectId, where.projectId) : isNull(taskAttachments.projectId);
  const [same] = await db
    .select({ storagePath: taskAttachments.storagePath })
    .from(taskAttachments)
    .where(and(scope, eq(taskAttachments.sha256, sha256)))
    .limit(1);

  let storagePath = same?.storagePath;
  if (!storagePath) {
    // Quota counts each stored blob once (deleted rows too — their bytes stay).
    const [{ used }] = await db
      .select({ used: sql<number>`coalesce(sum(size_bytes), 0)::bigint` })
      .from(
        db
          .selectDistinctOn([taskAttachments.sha256], { size_bytes: taskAttachments.sizeBytes })
          .from(taskAttachments)
          .where(scope)
          .as("blobs"),
      );
    if (Number(used) + a.bytes.length > MAX_PROJECT_BYTES) {
      throw new Error(
        `Not attached: the project's attachments would reach ${mb(Number(used) + a.bytes.length)} — the limit is ${mb(MAX_PROJECT_BYTES)} per project.`,
      );
    }
    storagePath = `${where.folder}/${sha256.slice(0, 12)}-${name}`;
    const dest = join(attachmentsRoot(), storagePath);
    await mkdir(join(attachmentsRoot(), where.folder), { recursive: true });
    // Write beside, then rename: a half-written file never carries the final name.
    const part = `${dest}.part-${randomUUID().slice(0, 8)}`;
    await writeFile(part, a.bytes);
    await rename(part, dest);
    const st = await stat(dest);
    if (st.size !== a.bytes.length) throw new Error(`Storing "${name}" failed: wrote ${st.size} of ${a.bytes.length} bytes.`);
  }

  const [{ prev }] = await db
    .select({ prev: sql<number>`coalesce(max(${taskAttachments.version}), 0)` })
    .from(taskAttachments)
    .where(and(eq(taskAttachments.taskId, a.taskId), eq(taskAttachments.name, name)));
  const version = Number(prev) + 1;

  const [row] = await db
    .insert(taskAttachments)
    .values({
      taskId: a.taskId,
      commentId: a.commentId ?? null,
      projectId: where.projectId,
      name,
      version,
      contentType,
      sizeBytes: a.bytes.length,
      sha256,
      kind: a.kind,
      caption: a.caption?.trim() || null,
      storagePath,
      sourcePath: a.sourcePath ?? null,
      createdBy: a.actor,
    })
    .returning();
  await db.insert(taskActivity).values({
    taskId: a.taskId,
    actor: a.actor,
    kind: "attachment",
    field: version > 1 ? "version" : "attached",
    toValue: version > 1 ? `${name} (v${version})` : name,
    body: row.id,
  });
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, a.taskId));
  return row;
}

export async function getAttachment(db: Db, id: string): Promise<TaskAttachment | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(taskAttachments).where(eq(taskAttachments.id, id));
  return row ?? null;
}

/** The stored bytes, checked against the row's sha256. */
export async function readAttachment(row: TaskAttachment): Promise<Buffer> {
  const bytes = await readFile(join(attachmentsRoot(), row.storagePath));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== row.sha256) throw new Error(`Stored bytes of "${row.name}" don't match its sha256 — the file was changed on disk.`);
  return bytes;
}

export async function listAttachments(
  db: Db,
  taskId: string,
  opts: { kind?: AttachmentKind; includeDeleted?: boolean } = {},
): Promise<TaskAttachment[]> {
  return db
    .select()
    .from(taskAttachments)
    .where(
      and(
        eq(taskAttachments.taskId, taskId),
        opts.kind ? eq(taskAttachments.kind, opts.kind) : undefined,
        opts.includeDeleted ? undefined : isNull(taskAttachments.deletedAt),
      ),
    )
    .orderBy(desc(taskAttachments.createdAt));
}

/** Soft delete: hide the row, keep the bytes, log it on the item. */
export async function deleteAttachment(db: Db, id: string, actor: Actor): Promise<TaskAttachment> {
  const row = await getAttachment(db, id);
  if (!row) throw new Error("No such attachment");
  if (row.deletedAt) return row;
  const [out] = await db
    .update(taskAttachments)
    .set({ deletedAt: new Date(), deletedBy: actor })
    .where(eq(taskAttachments.id, id))
    .returning();
  await db.insert(taskActivity).values({
    taskId: row.taskId,
    actor,
    kind: "attachment",
    field: "deleted",
    toValue: row.version > 1 ? `${row.name} (v${row.version})` : row.name,
    body: row.id,
  });
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId));
  return out;
}

/** Write an attachment to a local folder under a name that is never taken. */
export async function saveAttachmentTo(row: TaskAttachment, dir?: string): Promise<string> {
  const folder = dir?.trim() || DOWNLOADS();
  if (!isAbsolute(folder)) throw new Error(`saveTo must be an absolute folder: ${folder}`);
  await mkdir(folder, { recursive: true });
  const bytes = await readAttachment(row);
  const ext = extname(row.name);
  const stem = row.name.slice(0, row.name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const file = join(folder, `${stem}${row.version > 1 ? ` (v${row.version})` : ""}${i ? ` ${i + 1}` : ""}${ext}`);
    try {
      await writeFile(file, bytes, { flag: "wx" });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`No free file name for ${row.name} in ${folder}`);
}

/** Metadata an agent or the UI sees — never the storage path's root. */
export function attachmentMeta(a: TaskAttachment) {
  return {
    id: a.id,
    name: a.name,
    version: a.version,
    kind: a.kind,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    caption: a.caption,
    commentId: a.commentId,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    ...(a.deletedAt ? { deletedAt: a.deletedAt, deletedBy: a.deletedBy } : {}),
    url: attachmentUrl(a.id),
  };
}
