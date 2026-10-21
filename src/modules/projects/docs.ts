/**
 * Project docs: named, versioned documents per project (see schema). Writes
 * are optimistic — pass `expectedVersion` and a write that lost to a newer one
 * is refused with the current version and body, nothing written. Bodies are
 * stored and returned exactly as given (no trimming), so a round trip is
 * byte-identical.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { projectDocs, projectDocVersions, type ProjectDoc } from "./schema";

/** Well above the 64 KB a resume note needs; still a document, not a blob. */
export const DOC_MAX_BYTES = 512 * 1024;
export const DOC_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface DocConflict {
  error: "conflict";
  message: string;
  current: { version: number; title: string; body: string; updatedAt: Date; updatedBy: string; deleted: boolean } | null;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Why a body or key can't be stored, or null. */
export function invalidDoc(key: string, body: string): string | null {
  if (!DOC_KEY_RE.test(key)) return `"${key}" isn't a valid key — lowercase letters, digits and dashes, starting with a letter or digit (e.g. lead-resume)`;
  if (body.includes("\u0000")) return "the body contains a NUL character, which can't be stored";
  if (bytes(body) > DOC_MAX_BYTES) return `the body is ${bytes(body)} bytes; the limit is ${DOC_MAX_BYTES}`;
  return null;
}

const conflictOf = (cur: ProjectDoc | undefined, expected: number): DocConflict => ({
  error: "conflict",
  message: cur
    ? `The doc is at version ${cur.version}, not ${expected} — nothing was written. Re-read it, merge, and write again with expectedVersion ${cur.version}.`
    : `The doc doesn't exist (version 0), not ${expected} — nothing was written.`,
  current: cur
    ? { version: cur.version, title: cur.title, body: cur.body, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy, deleted: !!cur.deletedAt }
    : null,
});

export async function listDocs(db: Db, projectId: string, opts: { deleted?: boolean } = {}) {
  return db
    .select({
      key: projectDocs.key,
      title: projectDocs.title,
      version: projectDocs.version,
      updatedAt: projectDocs.updatedAt,
      updatedBy: projectDocs.updatedBy,
      deletedAt: projectDocs.deletedAt,
    })
    .from(projectDocs)
    .where(and(eq(projectDocs.projectId, projectId), opts.deleted ? undefined : isNull(projectDocs.deletedAt)))
    .orderBy(asc(projectDocs.key));
}

export async function findDoc(db: Db, projectId: string, key: string) {
  const [doc] = await db
    .select()
    .from(projectDocs)
    .where(and(eq(projectDocs.projectId, projectId), eq(projectDocs.key, key)));
  return doc;
}

/** One version of a doc (the latest when `version` is omitted). */
export async function readDoc(db: Db, projectId: string, key: string, version?: number) {
  const doc = await findDoc(db, projectId, key);
  if (!doc) return null;
  if (version === undefined || version === doc.version) return { doc, version: doc.version, title: doc.title, body: doc.body };
  const [v] = await db
    .select()
    .from(projectDocVersions)
    .where(and(eq(projectDocVersions.docId, doc.id), eq(projectDocVersions.version, version)));
  return v ? { doc, version: v.version, title: v.title, body: v.body, at: v.createdAt, by: v.updatedBy } : { doc, missing: version };
}

export async function docHistory(db: Db, docId: string) {
  return db
    .select({
      version: projectDocVersions.version,
      change: projectDocVersions.change,
      title: projectDocVersions.title,
      body: projectDocVersions.body,
      guarded: projectDocVersions.guarded,
      updatedBy: projectDocVersions.updatedBy,
      updatedAt: projectDocVersions.createdAt,
    })
    .from(projectDocVersions)
    .where(eq(projectDocVersions.docId, docId))
    .orderBy(desc(projectDocVersions.version));
}

/**
 * Create or replace a doc. With `expectedVersion` the write lands only if the
 * doc is still at that version (0 = must not exist yet); otherwise a conflict
 * comes back and nothing changes. Without it the write always lands and is
 * recorded as unguarded. Writing a deleted doc's key brings it back.
 */
export async function putDoc(
  db: Db,
  input: { projectId: string; key: string; body: string; title?: string; expectedVersion?: number; actor: string },
  change: "write" | "delete" = "write",
): Promise<ProjectDoc | DocConflict> {
  const { projectId, key, body, expectedVersion, actor } = input;
  try {
    return await db.transaction(async (tx) => {
      // Row lock: two writers holding the same version serialize here, and the
      // second sees the first's version.
      const [cur] = await tx
        .select()
        .from(projectDocs)
        .where(and(eq(projectDocs.projectId, projectId), eq(projectDocs.key, key)))
        .for("update");
      if (expectedVersion !== undefined && (cur?.version ?? 0) !== expectedVersion) return conflictOf(cur, expectedVersion);
      const title = input.title ?? cur?.title ?? key;
      const now = new Date();
      let row: ProjectDoc;
      if (cur) {
        [row] = await tx
          .update(projectDocs)
          .set({
            title,
            body,
            version: cur.version + 1,
            updatedBy: actor,
            updatedAt: now,
            deletedAt: change === "delete" ? now : null,
          })
          .where(eq(projectDocs.id, cur.id))
          .returning();
      } else {
        [row] = await tx.insert(projectDocs).values({ projectId, key, title, body, updatedBy: actor }).returning();
      }
      await tx.insert(projectDocVersions).values({
        docId: row.id,
        version: row.version,
        title,
        body,
        change,
        guarded: expectedVersion !== undefined,
        updatedBy: actor,
      });
      return row;
    });
  } catch (e) {
    // Two creates of one key raced past the lock (no row to lock yet): the
    // unique index let one in — the other is a conflict, not a crash.
    if ((e as { code?: string }).code === "23505") return conflictOf(await findDoc(db, projectId, key), expectedVersion ?? 0);
    throw e;
  }
}

/** Soft delete: the doc leaves the list, its history stays (a delete is a version too). */
export async function deleteDoc(db: Db, input: { projectId: string; key: string; expectedVersion?: number; actor: string }) {
  const cur = await findDoc(db, input.projectId, input.key);
  if (!cur || cur.deletedAt) return null;
  return putDoc(db, { ...input, body: cur.body, title: cur.title }, "delete");
}

// ── sections ────────────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*\r?$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;

/**
 * Replace the text under one markdown heading — up to the next heading of the
 * same or a higher level — leaving the heading line and everything else byte
 * for byte. `heading` matches its text ("Next steps") or the full line
 * ("## Next steps"); it must match exactly one heading outside code fences.
 */
export function replaceSection(doc: string, heading: string, content: string): { body: string } | { error: string } {
  const lines = doc.split("\n");
  const want = heading.trim();
  const heads: { i: number; level: number }[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line)?.[1];
    if (f) fence = fence === f ? null : (fence ?? f);
    if (fence) return;
    const m = HEADING.exec(line);
    if (m && (m[2] === want || line.replace(/\r$/, "").trim() === want)) heads.push({ i, level: m[1].length });
  });
  if (!heads.length) return { error: `No heading "${want}" in the doc` };
  if (heads.length > 1) return { error: `"${want}" matches ${heads.length} headings — pass the full heading line, e.g. "## ${want}"` };
  const { i, level } = heads[0];
  let end = lines.length;
  fence = null;
  for (let j = i + 1; j < lines.length; j++) {
    const f = FENCE.exec(lines[j])?.[1];
    if (f) fence = fence === f ? null : (fence ?? f);
    if (fence) continue;
    const m = HEADING.exec(lines[j]);
    if (m && m[1].length <= level) {
      end = j;
      break;
    }
  }
  const before = lines.slice(0, i + 1).join("\n") + "\n";
  const after = end < lines.length ? lines.slice(end).join("\n") : "";
  // The next heading must start on its own line.
  const middle = after && content && !content.endsWith("\n") ? `${content}\n` : content;
  return { body: before + middle + after };
}

// ── diff ────────────────────────────────────────────────────────────────────

/** Lines past this on either side fall back to a whole-block replace. */
const DIFF_MAX_LINES = 4000;

/**
 * A unified-style line diff of two versions: "-" removed, "+" added, " "
 * context (3 lines around each change); "@@" marks a skipped stretch.
 */
export function lineDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  if (a === b) return "";
  type Op = [" " | "-" | "+", string];
  let ops: Op[];
  if (x.length > DIFF_MAX_LINES || y.length > DIFF_MAX_LINES) {
    ops = [...x.map((l): Op => ["-", l]), ...y.map((l): Op => ["+", l])];
  } else {
    // LCS table over lines, then walk it.
    const n = x.length;
    const m = y.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        ops.push([" ", x[i++]]);
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push(["-", x[i++]]);
      else ops.push(["+", y[j++]]);
    }
    while (i < n) ops.push(["-", x[i++]]);
    while (j < m) ops.push(["+", y[j++]]);
  }
  const keep = ops.map((o, k) => o[0] !== " " || ops.slice(Math.max(0, k - 3), k + 4).some((p) => p[0] !== " "));
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (skipped) out.push("@@");
      skipped = false;
      out.push(o[0] + o[1]);
    } else skipped = true;
  });
  return out.join("\n");
}
