import { z } from "zod";
import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { registerRefs, resolveRef } from "@/core/ai/refs";
import { resolveProjectByName } from "@/modules/projects/subject";
import { features, projects } from "@/modules/projects/schema";
import {
  addComment,
  createWorkItem,
  deleteWorkItem,
  findByIdentifier,
  getWorkItem,
  updateWorkItem,
  withIdentifiers,
  type WorkItemPatch,
} from "./core";
import { parseIdentifier } from "./keys";
import {
  OPEN_STATUSES,
  priorityRank,
  tasks,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
} from "./schema";

const actorOf = (ctx: AiToolContext) => (ctx.agentName ? `agent:${ctx.agentName}` : "agent");

/** A work item is targeted by its list `ref` (t3) or its identifier (ETHOS-12) — never a raw id. */
async function resolveTask(ctx: AiToolContext, ref: string): Promise<{ id: string } | { error: string }> {
  if (parseIdentifier(ref)) {
    const t = await findByIdentifier(ctx.db, ref);
    return t ? { id: t.id } : { error: `No work item ${ref.toUpperCase()}` };
  }
  return resolveRef(ctx, "task", ref);
}

/** Project by name, by key (ETHOS), or — when omitted — the focused subject. */
async function resolveProject(
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

async function resolveFeature(ctx: AiToolContext, projectId: string, name: string) {
  const [f] = await ctx.db
    .select({ id: features.id })
    .from(features)
    .where(and(eq(features.projectId, projectId), sql`lower(${features.name}) = ${name.trim().toLowerCase()}`));
  return f ? { ref: `features:${f.id}` } : { error: `No feature "${name}" in that project` };
}

const summary = (t: Task & { identifier: string | null }) => ({
  id: t.id,
  identifier: t.identifier,
  title: t.title,
  status: t.status,
  priority: t.priority,
  estimate: t.estimate,
  labels: t.labels,
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
      project: z
        .string()
        .optional()
        .describe("Project/area NAME or key (validated) — never a raw id. Omit to use the focused project."),
      feature: z.string().optional().describe("Feature NAME within that project"),
      parent: z.string().optional().describe("Parent item (ref like 't3' or identifier like 'ETHOS-4') to make this a sub-item"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      let featureRef: string | null = null;
      if (input.feature) {
        if (!p) return { error: "a feature needs a project" };
        const f = await resolveFeature(ctx, p.id, input.feature);
        if ("error" in f) return f;
        featureRef = f.ref;
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
          projectRef: p ? `projects:${p.id}` : null,
          featureRef,
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
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
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
      ].filter((f) => f !== undefined);
      const rows = await ctx.db
        .select()
        .from(tasks)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(priorityRank, asc(tasks.sortOrder))
        .limit(input.limit);
      const items = await withIdentifiers(ctx.db, rows);
      return registerRefs(ctx, "task", "t", items.map(summary));
    },
  },
  {
    name: "tasks.get",
    description: "Full detail of one work item: notes, sub-items, parent, and its history/comments.",
    input: z.object({ ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')") }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      const d = await getWorkItem(ctx.db, t.id);
      if (!d) return { error: "work item not found" };
      const [item] = registerRefs(ctx, "task", "t", [summary(d.item)]);
      return {
        ...item,
        notes: d.item.notes,
        parent: d.parent ? { identifier: d.parent.identifier, title: d.parent.title } : null,
        subItems: registerRefs(ctx, "task", "t", d.children.map(summary)),
        activity: d.activity.slice(-20).map((a) =>
          a.kind === "comment"
            ? { at: a.createdAt, by: a.actor, comment: a.body }
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
      feature: z.string().optional().describe("Feature NAME in its project; empty string detaches"),
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
            projectId = cur?.projectRef?.startsWith("projects:") ? cur.projectRef.slice(9) : null;
          }
          if (!projectId) return { error: "a feature needs the item to be in a project" };
          const f = await resolveFeature(ctx, projectId, input.feature);
          if ("error" in f) return f;
          patch.featureRef = f.ref;
        }
      }
      if (Object.values(patch).every((v) => v === undefined)) return { error: "nothing to update" };
      const row = await updateWorkItem(ctx.db, t.id, patch, actorOf(ctx));
      return row ? { updated: { identifier: row.identifier, title: row.title } } : { error: "work item not found" };
    },
  },
  {
    name: "tasks.comment",
    description: "Add a comment to a work item's discussion (your findings, a question, a status note).",
    input: z.object({
      ref: z.string().describe("Ref from tasks.list ('t3') or identifier ('ETHOS-12')"),
      body: z.string().min(1),
    }),
    async execute(input, ctx) {
      const t = await resolveTask(ctx, input.ref);
      if ("error" in t) return t;
      await addComment(ctx.db, t.id, input.body, actorOf(ctx));
      return { commented: true };
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
