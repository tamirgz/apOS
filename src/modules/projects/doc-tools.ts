/**
 * Agent tools for project docs (docs.ts): durable per-project state that is
 * not a work item. Same conventions as the tracker tools — a project is named
 * by NAME or key, never by id; writes are optimistic via `expectedVersion`.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { actorOf, resolveProject } from "@/modules/tasks/tools";
import { deleteDoc, docHistory, findDoc, invalidDoc, lineDiff, listDocs, putDoc, readDoc, replaceSection } from "./docs";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const size = (s: string) => Buffer.byteLength(s, "utf8");

const PROJECT = z.string().min(1).describe("Project NAME or key (e.g. ETHOS-Sec or ES) — never an id");
const KEY = z.string().min(1).describe("The doc's key — a slug unique in the project, e.g. 'lead-resume'");
const EXPECTED = z
  .number()
  .int()
  .min(0)
  .describe(
    "The version you last read (0 = the doc must not exist yet). The write lands only if the doc is still at it; otherwise you get {error:'conflict', current:{version, body…}} and nothing is written — merge and retry.",
  );

/** The named project (required here — a doc never lands on a guessed project). */
async function projectOf(ctx: AiToolContext, name: string) {
  const p = await resolveProject(ctx, name);
  return p ?? { error: `No project "${name}"` };
}

const written = (row: { key: string; title: string; version: number; body: string }, guarded: boolean) => ({
  written: { key: row.key, title: row.title, version: row.version, sizeBytes: size(row.body), sha256: sha256(row.body), guarded },
});

export const docTools: AiToolDef[] = [
  {
    name: "docs.list",
    description:
      "List a project's docs — named, versioned documents that hold durable state (resume notes, standing decisions, open questions). Docs are not work items: no status, owner, cycle, module or milestone.",
    input: z.object({
      project: PROJECT,
      includeDeleted: z.boolean().default(false).describe("Also list soft-deleted docs"),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const rows = await listDocs(ctx.db, p.id, { deleted: input.includeDeleted });
      return rows.map((d) => ({
        key: d.key,
        title: d.title,
        version: d.version,
        updatedAt: d.updatedAt,
        updatedBy: d.updatedBy,
        ...(d.deletedAt ? { deleted: true } : {}),
      }));
    },
  },
  {
    name: "docs.get",
    description:
      "Read a project doc: its full body exactly as stored, plus version, size and sha256. The latest version unless `version` names an older one.",
    input: z.object({
      project: PROJECT,
      key: KEY,
      version: z.number().int().min(1).optional().describe("An older version to read (see docs.history)"),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const r = await readDoc(ctx.db, p.id, input.key, input.version);
      if (!r) return { error: `No doc "${input.key}" in that project` };
      if ("missing" in r) return { error: `"${input.key}" has no version ${r.missing} (latest is ${r.doc.version})` };
      return {
        key: r.doc.key,
        title: r.title,
        version: r.version,
        latestVersion: r.doc.version,
        updatedAt: r.at ?? r.doc.updatedAt,
        updatedBy: r.by ?? r.doc.updatedBy,
        ...(r.doc.deletedAt ? { deleted: true } : {}),
        sizeBytes: size(r.body),
        sha256: sha256(r.body),
        body: r.body,
      };
    },
  },
  {
    name: "docs.put",
    description:
      "Create or replace a project doc. The body is stored exactly as given (up to 512 KB) and the previous version is kept in history. Pass `expectedVersion` (the version you read, or 0 for a new doc) so a concurrent writer can't be overwritten unseen; a write without it still lands but is recorded as unguarded.",
    input: z.object({
      project: PROJECT,
      key: KEY,
      body: z.string().describe("The whole document (markdown or plain text)"),
      title: z.string().min(1).optional().describe("Title (defaults to the current title, or the key for a new doc)"),
      expectedVersion: EXPECTED.optional(),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const bad = invalidDoc(input.key, input.body);
      if (bad) return { error: `Not written: ${bad}` };
      const row = await putDoc(ctx.db, { projectId: p.id, ...input, actor: actorOf(ctx) });
      return "error" in row ? row : written(row, input.expectedVersion !== undefined);
    },
  },
  {
    name: "docs.patchSection",
    description:
      "Replace the text under one markdown heading of a project doc — up to the next heading of the same or a higher level — without resending the whole doc. The heading line itself and everything outside the section stay byte for byte. Needs `expectedVersion`.",
    input: z.object({
      project: PROJECT,
      key: KEY,
      heading: z.string().min(1).describe("The heading's text ('Next steps') or its full line ('## Next steps')"),
      body: z.string().describe("The section's new content (without the heading line)"),
      expectedVersion: EXPECTED,
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const cur = await findDoc(ctx.db, p.id, input.key);
      if (!cur || cur.deletedAt) return { error: `No doc "${input.key}" in that project` };
      const r = replaceSection(cur.body, input.heading, input.body);
      if ("error" in r) return { error: `Not written: ${r.error}` };
      const bad = invalidDoc(input.key, r.body);
      if (bad) return { error: `Not written: ${bad}` };
      const row = await putDoc(ctx.db, {
        projectId: p.id,
        key: input.key,
        body: r.body,
        expectedVersion: input.expectedVersion,
        actor: actorOf(ctx),
      });
      return "error" in row ? row : written(row, true);
    },
  },
  {
    name: "docs.history",
    description:
      "A project doc's versions, newest first: when, by whom, size, whether the write was guarded (named the version it replaced), and deletes. Read any of them with docs.get {version}; compare with docs.diff.",
    input: z.object({ project: PROJECT, key: KEY }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const doc = await findDoc(ctx.db, p.id, input.key);
      if (!doc) return { error: `No doc "${input.key}" in that project` };
      return (await docHistory(ctx.db, doc.id)).map((v) => ({
        version: v.version,
        ...(v.change === "delete" ? { change: "deleted" } : {}),
        title: v.title,
        updatedAt: v.updatedAt,
        updatedBy: v.updatedBy,
        sizeBytes: size(v.body),
        guarded: v.guarded,
      }));
    },
  },
  {
    name: "docs.diff",
    description:
      "Line diff between two versions of a project doc ('-' removed, '+' added, ' ' context, '@@' skipped unchanged lines). `to` defaults to the latest version.",
    input: z.object({
      project: PROJECT,
      key: KEY,
      from: z.number().int().min(1),
      to: z.number().int().min(1).optional(),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const a = await readDoc(ctx.db, p.id, input.key, input.from);
      if (!a) return { error: `No doc "${input.key}" in that project` };
      const b = await readDoc(ctx.db, p.id, input.key, input.to);
      for (const r of [a, b]) if (r && "missing" in r) return { error: `"${input.key}" has no version ${r.missing}` };
      if ("missing" in a || !b || "missing" in b) return { error: "version not found" };
      const diff = lineDiff(a.body, b.body);
      return { key: input.key, from: a.version, to: b.version, ...(a.title !== b.title ? { title: { from: a.title, to: b.title } } : {}), identical: !diff, diff };
    },
  },
  {
    name: "docs.delete",
    description:
      "Soft-delete a project doc: it leaves docs.list but its whole history stays readable, and writing its key again brings it back. Needs confirm: true.",
    input: z.object({
      project: PROJECT,
      key: KEY,
      confirm: z.literal(true).describe("Must be true"),
      expectedVersion: EXPECTED.optional(),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const row = await deleteDoc(ctx.db, { projectId: p.id, key: input.key, expectedVersion: input.expectedVersion, actor: actorOf(ctx) });
      if (!row) return { error: `No doc "${input.key}" in that project` };
      return "error" in row ? row : { deleted: { key: row.key, version: row.version } };
    },
  },
];
