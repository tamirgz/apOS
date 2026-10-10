import { z } from "zod";
import { and, asc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { registerRefs, resolveRef } from "@/core/ai/refs";
import { resolveProjectByName } from "@/modules/projects/subject";
import { features, projects } from "@/modules/projects/schema";
import {
  addComment,
  addRelation,
  blockingRelations,
  createWorkItem,
  deleteWorkItem,
  findByIdentifier,
  getWorkItem,
  listRelations,
  removeRelation,
  updateWorkItem,
  withIdentifiers,
  type WorkItemPatch,
} from "./core";
import { ACCEPTED_EXTENSIONS, addAttachment, attachmentMeta, decodeBase64, readLocalFile, typeOf } from "./attachments";
import { cycleStatus } from "./cycles";
import { delegateWorkItem } from "./delegate";
import { parseIdentifier } from "./keys";
import {
  cycles,
  OPEN_STATUSES,
  priorityRank,
  tasks,
  TASK_PRIORITIES,
  TASK_STATUSES,
  ATTACHMENT_KINDS,
  type Task,
} from "./schema";

const RELATION_SIDES = ["blocks", "blocked_by", "relates", "duplicates", "duplicated_by"] as const;

export const actorOf = (ctx: AiToolContext) => (ctx.agentName ? `agent:${ctx.agentName}` : "agent");

/** One file to attach — from a local path (read on this Mac) or inline base64. */
export const fileInput = {
  path: z.string().optional().describe("Absolute path of a file on this Mac — the apOS MCP server runs locally and reads it directly"),
  contentBase64: z.string().optional().describe("The file's bytes, base64 — when the file isn't on this Mac"),
  name: z.string().optional().describe("File name with extension (defaults to the path's file name); re-using a name adds a new version"),
  kind: z.enum(ATTACHMENT_KINDS).default("other"),
  caption: z.string().optional(),
};

/** Resolve a fileInput to bytes + name, validated before anything is written. */
export async function loadFile(f: { path?: string; contentBase64?: string; name?: string }) {
  if (!!f.path === !!f.contentBase64) return { error: "Give exactly one of `path` or `contentBase64`." } as const;
  let bytes: Buffer;
  let sourcePath: string | null = null;
  if (f.path) {
    const r = await readLocalFile(f.path);
    if ("error" in r) return r;
    bytes = r.bytes;
    sourcePath = r.path;
  } else {
    const b = decodeBase64(f.contentBase64!);
    if ("error" in b) return b;
    bytes = b;
  }
  const name = f.name?.trim() || (f.path ? f.path.split("/").pop()! : "");
  if (!name) return { error: "`name` is required with contentBase64." } as const;
  if (!typeOf(name)) return { error: `Not attached: "${name}" isn't an accepted type (${ACCEPTED_EXTENSIONS}).` } as const;
  return { bytes, name, sourcePath } as const;
}

/** A work item is targeted by its list `ref` (t3) or its identifier (ETHOS-12) — never a raw id. */
export async function resolveTask(ctx: AiToolContext, ref: string): Promise<{ id: string } | { error: string }> {
  if (parseIdentifier(ref)) {
    const t = await findByIdentifier(ctx.db, ref);
    return t ? { id: t.id } : { error: `No work item ${ref.toUpperCase()}` };
  }
  return resolveRef(ctx, "task", ref);
}

/** Project by name, by key (ETHOS), or — when omitted — the focused subject. */
export async function resolveProject(
  ctx: AiToolContext,
  name: string | undefined,
): Promise<{ id: string } | { error: string } | null> {
  if (name === undefined) return ctx.subject?.kind === "project" ? { id: ctx.subject.id } : null;
  if (/^[A-Za-z]{2,5}$/.test(name.trim())) {
    const [p] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.key, name.trim().toUpperCase()));
    if (p) return p;
  }
  return resolveProjectByName(ctx, name);
}

/** A module/feature by its list ref (m2) or its NAME within the project. */
export async function resolveFeature(ctx: AiToolContext, projectId: string | null, name: string) {
  if (/^m\d+$/.test(name.trim())) {
    const r = resolveRef(ctx, "module", name);
    return "error" in r ? r : { ref: `features:${r.id}` };
  }
  if (!projectId) return { error: "a module needs a project" };
  const [f] = await ctx.db
    .select({ id: features.id })
    .from(features)
    .where(and(eq(features.projectId, projectId), sql`lower(${features.name}) = ${name.trim().toLowerCase()}`));
  return f ? { ref: `features:${f.id}` } : { error: `No module "${name}" in that project` };
}

/**
 * A cycle by its list ref (c1), "current" (the project's running cycle, else a
 * cross-project one), or its NAME (case-insensitive).
 */
export async function resolveCycle(ctx: AiToolContext, projectId: string | null, name: string): Promise<{ id: string } | { error: string }> {
  const key = name.trim();
  if (/^c\d+$/.test(key)) return resolveRef(ctx, "cycle", key);
  const rows = await ctx.db.select().from(cycles);
  const scoped = rows.filter((c) => !c.projectId || !projectId || c.projectId === projectId);
  if (key.toLowerCase() === "current") {
    const cur = scoped.filter((c) => cycleStatus(c) === "current").sort((a, b) => Number(!!b.projectId) - Number(!!a.projectId));
    return cur[0] ? { id: cur[0].id } : { error: "No cycle is running now" };
  }
  const hit = scoped.find((c) => c.name.toLowerCase() === key.toLowerCase());
  return hit ? { id: hit.id } : { error: `No cycle "${name}"` };
}

const projectIdOfRef = (ref: string | null | undefined) => (ref?.startsWith("projects:") ? ref.slice(9) : null);

const summary = (t: Task & { identifier: string | null }) => ({
  id: t.id,
  identifier: t.identifier,
  title: t.title,
  status: t.status,
  priority: t.priority,
  estimate: t.estimate,
  labels: t.labels,
  startAt: t.startAt,
  dueAt: t.dueAt,
  completedAt: t.completedAt,
  hasParent: !!t.parentId,
});

const isoOrNull = (s: string | undefined) => (s === undefined ? undefined : s ? new Date(s) : null);

export const taskTools: AiToolDef[] = [
  {
    name: "tasks.create",
    description:
      "Create a work item. Files under the named project (or the project you are focused on). Returns its identifier (e.g. ETHOS-12).",
    input: z.object({
      title: z.string().min(1).describe("Short imperative title"),
      notes: z.string().optional().describe("Extra details (markdown)"),
      status: z.enum(TASK_STATUSES).default("todo"),
      priority: z.enum(TASK_PRIORITIES).default("medium"),
      estimate: z.number().int().min(0).max(100).optional().describe("Size in points (1,2,3,5,8)"),
      labels: z.array(z.string()).optional(),
      dueAt: z.string().optional().describe("Due date-time in ISO 8601, if known"),
      startAt: z.string().optional().describe("Start date in ISO 8601 (with dueAt, its bar on the timeline)"),
      project: z
        .string()
        .optional()
        .describe("Project/area NAME or key (validated) — never a raw id. Omit to use the focused project."),
      feature: z.string().optional().describe("Module (feature) NAME within that project, or its ref from modules.list ('m2')"),
      cycle: z.string().optional().describe("Cycle NAME, its ref from cycles.list ('c1'), or 'current'"),
      parent: z.string().optional().describe("Parent item (ref like 't3' or identifier like 'ETHOS-4') to make this a sub-item"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      let featureRef: string | null = null;
      if (input.feature) {
        const f = await resolveFeature(ctx, p?.id ?? null, input.feature);
        if ("error" in f) return f;
        featureRef = f.ref;
      }
      let cycleId: string | null = null;
      if (input.cycle) {
        const c = await resolveCycle(ctx, p?.id ?? null, input.cycle);
        if ("error" in c) return c;
        cycleId = c.id;
      }
      let parentId: string | null = null;
      if (input.parent) {
        const t = await resolveTask(ctx, input.parent);
        if ("error" in t) return t;
        parentId = t.id;
      }
      const item = await createWorkItem(
        ctx.db,
        {
          title: input.title,
          notes: input.notes,
          status: input.status,
          priority: input.priority,
          estimate: input.estimate,
          labels: input.labels,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          startAt: input.startAt ? new Date(input.startAt) : null,
          projectRef: p ? `projects:${p.id}` : null,
          featureRef,
          cycleId,
          parentId,
        },
        actorOf(ctx),
      );
      return { created: { identifier: item.identifier, title: item.title, status: item.status } };
    },
  },
  {
    name: "tasks.list",
    description:
      "List work items. Defaults to OPEN items (backlog/todo/doing/review) of the named project, or the focused project, or all. Each comes back with a `ref` (t1…) and an `identifier` (KEY-N) — use either to target it.",
    input: z.object({
      status: z
        .enum([...TASK_STATUSES, "open", "all"])
        .default("open")
        .describe("A single state, 'open' (default) or 'all'"),
      project: z.string().optional().describe("Project NAME or key; omit for the focused project (or all)"),
      search: z.string().optional().describe("Case-insensitive title filter"),
      label: z.string().optional(),
      module: z.string().optional().describe("Only items in this module (NAME or 'm2'); 'none' = items in no module"),
      cycle: z.string().optional().describe("Only items in this cycle (NAME, 'c1' or 'current'); 'none' = unplanned"),
      limit: z.number().int().min(1).max(100).default(50),
      relations: z
        .boolean()
        .default(false)
        .describe("Also return each item's blockedBy / blocks (identifier + status), in one round"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      let moduleFilter;
      if (input.module) {
        if (input.module === "none") moduleFilter = isNull(tasks.featureRef);
        else {
          const f = await resolveFeature(ctx, p?.id ?? null, input.module);
          if ("error" in f) return f;
          moduleFilter = eq(tasks.featureRef, f.ref);
        }
      }
      let cycleFilter;
      if (input.cycle) {
        if (input.cycle === "none") cycleFilter = isNull(tasks.cycleId);
        else {
          const c = await resolveCycle(ctx, p?.id ?? null, input.cycle);
          if ("error" in c) return c;
          cycleFilter = eq(tasks.cycleId, c.id);
        }
      }
      const statusFilter =
        input.status === "all"
          ? undefined
          : input.status === "open"
            ? inArray(tasks.status, [...OPEN_STATUSES])
            : eq(tasks.status, input.status);
      const filters = [
        statusFilter,
        p ? eq(tasks.projectRef, `projects:${p.id}`) : undefined,
        input.search ? ilike(tasks.title, `%${input.search}%`) : undefined,
        input.label ? sql`${input.label.toLowerCase()} = any(${tasks.labels})` : undefined,
        moduleFilter,
        cycleFilter,
      ].filter((f) => f !== undefined);
      const rows = await ctx.db
        .select()
        .from(tasks)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(priorityRank, asc(tasks.sortOrder))
        .limit(input.limit);
      const items = await withIdentifiers(ctx.db, rows);
      const [featureNames, cycleNames] = await Promise.all([
        ctx.db.select({ id: features.id, name: features.name }).from(features),
        ctx.db.select({ id: cycles.id, name: cycles.name }).from(cycles),
      ]);
      const fName = new Map(featureNames.map((f) => [`features:${f.id}`, f.name]));
      const cName = new Map(cycleNames.map((c) => [c.id, c.name]));
      const rels = input.relations ? await blockingRelations(ctx.db, items.map((t) => t.id)) : null;
      return registerRefs(
        ctx,
        "task",
        "t",
        items.map((t) => ({
          ...summary(t),
          module: t.featureRef ? (fName.get(t.featureRef) ?? null) : null,
          cycle: t.cycleId ? (cName.get(t.cycleId) ?? null) : null,
          ...(rels ? rels.get(t.id) : {}),
        })),
      );
    },
  },
  {
    name: "tasks.get",
    description:
      "Full detail of one work item: notes, sub-items, parent, relations (the full current set — blocks / blocked_by / relates / duplicates / duplicated_by, each with the other item's status), attachments (on the item and on each comment), and its recent history/comments (last 20).",
    input: z.object({ ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')") }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      const d = await getWorkItem(ctx.db, t.id);
      if (!d) return { error: "work item not found" };
      const [item] = registerRefs(ctx, "task", "t", [summary(d.item)]);
      const brief = (a: (typeof d.attachments)[number]) => ({ id: a.id, name: a.name, version: a.version, kind: a.kind, sizeBytes: a.sizeBytes, sha256: a.sha256 });
      const byComment = Map.groupBy(d.attachments.filter((a) => a.commentId), (a) => a.commentId!);
      return {
        ...item,
        notes: d.item.notes,
        parent: d.parent ? { identifier: d.parent.identifier, title: d.parent.title } : null,
        subItems: registerRefs(ctx, "task", "t", d.children.map(summary)),
        // Current state, read from the relations table — not from `activity`,
        // which is capped at the last 20 events.
        relations: d.relations.map((r) => ({
          relation: r.side,
          identifier: r.other.identifier,
          title: r.other.title,
          status: r.other.status,
        })),
        attachments: d.attachments.filter((a) => !a.commentId).map(brief),
        activity: d.activity.slice(-20).map((a) =>
          a.kind === "comment"
            ? {
                at: a.createdAt,
                by: a.actor,
                commentId: a.id,
                comment: a.body,
                ...(byComment.has(a.id) ? { attachments: byComment.get(a.id)!.map(brief) } : {}),
              }
            : { at: a.createdAt, by: a.actor, [a.kind]: a.field ?? true, from: a.fromValue, to: a.toValue },
        ),
      };
    },
  },
  {
    name: "tasks.setStatus",
    description:
      "Move a work item to a state: backlog | todo | doing | review | done | cancelled. Identify it by its `ref` ('t3') or identifier ('ETHOS-12').",
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
      status: z.enum(TASK_STATUSES),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      const row = await updateWorkItem(ctx.db, t.id, { status: input.status }, actorOf(ctx));
      return row ? { updated: { identifier: row.identifier, status: row.status } } : { error: "work item not found" };
    },
  },
  {
    name: "tasks.update",
    description:
      "Edit a work item. Pass only the fields to change. Identify it by its `ref` ('t3') or identifier ('ETHOS-12').",
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
      title: z.string().min(1).optional(),
      notes: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      estimate: z.number().int().min(0).max(100).nullable().optional(),
      labels: z.array(z.string()).optional().describe("Replaces the label set"),
      dueAt: z.string().optional().describe("ISO 8601; empty string clears it"),
      startAt: z.string().optional().describe("ISO 8601; empty string clears it"),
      project: z.string().optional().describe("Project NAME or key to move it to; empty string unfiles"),
      feature: z.string().optional().describe("Module (feature) NAME in its project or 'm2'; empty string detaches"),
      cycle: z.string().optional().describe("Cycle NAME, 'c1' or 'current'; empty string takes it out of its cycle"),
      parent: z.string().optional().describe("Parent item ('t3' / 'ETHOS-4') to nest it under; empty string makes it top-level"),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      const patch: WorkItemPatch = {
        title: input.title,
        notes: input.notes,
        status: input.status,
        priority: input.priority,
        estimate: input.estimate,
        labels: input.labels,
        dueAt: isoOrNull(input.dueAt),
        startAt: isoOrNull(input.startAt),
      };
      let projectId: string | null | undefined;
      if (input.project !== undefined) {
        if (input.project === "") {
          patch.projectRef = null;
          projectId = null;
        } else {
          const p = await resolveProject(ctx, input.project);
          if (!p || "error" in p) return p ?? { error: "project not found" };
          patch.projectRef = `projects:${p.id}`;
          projectId = p.id;
        }
      }
      if (input.feature !== undefined) {
        if (input.feature === "") patch.featureRef = null;
        else {
          if (projectId === undefined) {
            const [cur] = await ctx.db.select({ projectRef: tasks.projectRef }).from(tasks).where(eq(tasks.id, t.id));
            projectId = projectIdOfRef(cur?.projectRef);
          }
          const f = await resolveFeature(ctx, projectId, input.feature);
          if ("error" in f) return f;
          patch.featureRef = f.ref;
        }
      }
      if (input.cycle !== undefined) {
        if (input.cycle === "") patch.cycleId = null;
        else {
          if (projectId === undefined) {
            const [cur] = await ctx.db.select({ projectRef: tasks.projectRef }).from(tasks).where(eq(tasks.id, t.id));
            projectId = projectIdOfRef(cur?.projectRef);
          }
          const c = await resolveCycle(ctx, projectId, input.cycle);
          if ("error" in c) return c;
          patch.cycleId = c.id;
        }
      }
      if (input.parent !== undefined) {
        if (input.parent === "") patch.parentId = null;
        else {
          const parent = await resolveTask(ctx, input.parent);
          if ("error" in parent) return parent;
          if (parent.id === t.id) return { error: "an item can't be its own parent" };
          patch.parentId = parent.id;
        }
      }
      if (Object.values(patch).every((v) => v === undefined)) return { error: "nothing to update" };
      const row = await updateWorkItem(ctx.db, t.id, patch, actorOf(ctx));
      return row ? { updated: { identifier: row.identifier, title: row.title } } : { error: "work item not found" };
    },
  },
  {
    name: "tasks.comment",
    description:
      "Add a markdown comment to a work item's discussion (findings, a brief, a question, a status note — up to 100 KB+). Optional `attachments` are stored durably and linked to this comment in the same call.",
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
      body: z.string().min(1).describe("Markdown"),
      attachments: z.array(z.object(fileInput)).max(20).optional(),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      // Read + validate every file first, so a bad one leaves no half-made comment.
      const files = [];
      for (const f of input.attachments ?? []) {
        const r = await loadFile(f);
        if ("error" in r) return { error: `${r.error} Nothing was posted.` };
        files.push({ ...r, kind: f.kind, caption: f.caption });
      }
      const c = await addComment(ctx.db, t.id, input.body, actorOf(ctx));
      const attached = [];
      const failed = [];
      for (const f of files) {
        try {
          const a = await addAttachment(ctx.db, { taskId: t.id, commentId: c.id, actor: actorOf(ctx), ...f });
          attached.push((({ id, name, version, sha256, sizeBytes, url }) => ({ id, name, version, sha256, sizeBytes, url }))(attachmentMeta(a)));
        } catch (e) {
          failed.push({ name: f.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { commented: true, commentId: c.id, ...(files.length ? { attached } : {}), ...(failed.length ? { failed } : {}) };
    },
  },
  {
    name: "tasks.relate",
    description:
      "Link two work items: 'blocks' / 'blocked_by' (dependencies — a blocked item shows as blocked until its blocker closes), 'relates', 'duplicates' / 'duplicated_by'. Read as: <ref> <relation> <other>.",
    input: z.object({
      ref: z.string().describe("The item ('t3' or 'ETHOS-12')"),
      relation: z.enum(RELATION_SIDES),
      other: z.string().describe("The other item ('t5' or 'ETHOS-14')"),
    }),
    async execute(input, ctx) {
      const a = await resolveTask(ctx, input.ref);
      if ("error" in a) return a;
      const b = await resolveTask(ctx, input.other);
      if ("error" in b) return b;
      try {
        const row = await addRelation(ctx.db, a.id, input.relation, b.id, actorOf(ctx));
        return { related: !!row, note: row ? undefined : "they were already related that way" };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: "tasks.unrelate",
    description: "Remove every relation between two work items.",
    input: z.object({
      ref: z.string().describe("The item ('t3' or 'ETHOS-12')"),
      other: z.string().describe("The other item ('t5' or 'ETHOS-14')"),
    }),
    async execute(input, ctx) {
      const a = await resolveTask(ctx, input.ref);
      if ("error" in a) return a;
      const b = await resolveTask(ctx, input.other);
      if ("error" in b) return b;
      const hits = (await listRelations(ctx.db, a.id)).filter((r) => r.other.id === b.id);
      for (const r of hits) await removeRelation(ctx.db, r.id);
      return { removed: hits.length };
    },
  },
  {
    name: "tasks.delegate",
    description:
      "Hand a work item (and its open sub-items) to the Workbench: starts a coding/research agent run in the project's repo, moves the item to In progress, and writes the outcome back (review → In review, done → Done). Starts real work — use only when asked.",
    risk: "approval",
    input: z.object({
      ref: z.string().describe("The item ('t3' or 'ETHOS-12')"),
      instructions: z.string().optional().describe("Extra instructions for the run"),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      try {
        const wb = await delegateWorkItem(ctx.db, t.id, actorOf(ctx), input.instructions);
        return { delegated: true, workbenchTask: wb.id };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: "tasks.delete",
    description: "Delete a work item permanently. Identify it by its `ref` ('t3') or identifier ('ETHOS-12').",
    risk: "approval",
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      return (await deleteWorkItem(ctx.db, t.id)) ? { deleted: true } : { error: "work item not found" };
    },
  },
];
