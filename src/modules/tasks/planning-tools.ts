/**
 * Agent tools for the planning layer of the work tracker — cycles (time-boxed
 * sprints) and modules (a project's features: a deliverable with a start →
 * target span and a lifecycle). Same conventions as tools.ts: entities are
 * targeted by list refs (c1, m2) or names, never raw ids.
 */
import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AiToolDef } from "@/core/modules/types.server";
import { registerRefs } from "@/core/ai/refs";
import { FEATURE_STATUSES, features, projects } from "@/modules/projects/schema";
import { createCycle, cycleStatus, deleteCycle, listCycles, rollOverCycle, updateCycle } from "./cycles";
import { resolveCycle, resolveFeature, resolveProject } from "./tools";
import { isClosed, tasks } from "./schema";

const dateOrNull = (s: string | undefined) => (s === undefined ? undefined : s ? new Date(s) : null);
const errorOf = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

async function moduleProgress(db: Parameters<AiToolDef["execute"]>[1]["db"], ids: string[]) {
  if (!ids.length) return new Map<string, { total: number; done: number }>();
  const rows = await db
    .select({ featureRef: tasks.featureRef, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.featureRef, ids.map((id) => `features:${id}`)));
  const m = new Map<string, { total: number; done: number }>();
  for (const r of rows) {
    if (r.status === "cancelled") continue;
    const id = r.featureRef!.slice(9);
    const s = m.get(id) ?? { total: 0, done: 0 };
    s.total++;
    if (isClosed(r.status)) s.done++;
    m.set(id, s);
  }
  return m;
}

export const planningTools: AiToolDef[] = [
  // ── cycles ───────────────────────────────────────────────────────────────
  {
    name: "cycles.list",
    description:
      "List cycles (time-boxed sprints) with their dates, status (upcoming / current / completed) and progress. Each comes back with a `ref` (c1…) for tasks.create / tasks.update / cycles.update.",
    input: z.object({
      project: z.string().optional().describe("Project NAME or key: its cycles plus cross-project ones; omit for all"),
      include: z.enum(["open", "all"]).default("open").describe("'open' (default) skips completed cycles"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const rows = (await listCycles(ctx.db)).filter(
        (c) => (!p || !c.projectId || c.projectId === p.id) && (input.include === "all" || c.status !== "completed"),
      );
      return registerRefs(
        ctx,
        "cycle",
        "c",
        rows.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          crossProject: !c.projectId,
          items: c.total,
          done: c.done,
        })),
      );
    },
  },
  {
    name: "cycles.create",
    description: "Create a cycle (sprint) with a start and end date, for one project (or cross-project when no project applies).",
    input: z.object({
      name: z.string().min(1),
      startsAt: z.string().describe("Start date, ISO 8601"),
      endsAt: z.string().describe("End date, ISO 8601"),
      project: z.string().optional().describe("Project NAME or key; omit for the focused project, or a cross-project cycle"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      try {
        const c = await createCycle(ctx.db, { name: input.name, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), projectId: p?.id ?? null });
        const [row] = registerRefs(ctx, "cycle", "c", [{ id: c.id, name: c.name, status: cycleStatus(c) }]);
        return { created: row };
      } catch (e) {
        return errorOf(e);
      }
    },
  },
  {
    name: "cycles.update",
    description: "Rename a cycle or change its dates. Pass only what changes.",
    input: z.object({
      cycle: z.string().describe("Cycle ref ('c1'), NAME, or 'current'"),
      name: z.string().min(1).optional(),
      startsAt: z.string().optional().describe("ISO 8601"),
      endsAt: z.string().optional().describe("ISO 8601"),
    }),
    async execute(input, ctx) {
      const c = await resolveCycle(ctx, null, input.cycle);
      if ("error" in c) return c;
      try {
        await updateCycle(ctx.db, c.id, {
          name: input.name,
          startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
          endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
        });
        return { updated: true };
      } catch (e) {
        return errorOf(e);
      }
    },
  },
  {
    name: "cycles.rollOver",
    description: "Move a cycle's unfinished items into another cycle (or out of any cycle when `to` is omitted). Returns how many moved.",
    input: z.object({
      from: z.string().describe("Cycle ref ('c1') or NAME"),
      to: z.string().optional().describe("Target cycle ref or NAME; omit to un-plan them"),
    }),
    async execute(input, ctx) {
      const from = await resolveCycle(ctx, null, input.from);
      if ("error" in from) return from;
      let to: string | null = null;
      if (input.to) {
        const t = await resolveCycle(ctx, null, input.to);
        if ("error" in t) return t;
        to = t.id;
      }
      return { moved: await rollOverCycle(ctx.db, from.id, to) };
    },
  },
  {
    name: "cycles.delete",
    description:
      "Delete a cycle. Its work items are never deleted — they are un-planned (left without a cycle); use cycles.rollOver first to move them into another cycle instead. Returns how many items were un-planned.",
    risk: "approval",
    input: z.object({
      cycle: z.string().describe("Cycle ref ('c1') or NAME"),
    }),
    async execute(input, ctx) {
      const c = await resolveCycle(ctx, null, input.cycle);
      if ("error" in c) return c;
      const [{ n }] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.cycleId, c.id));
      await deleteCycle(ctx.db, c.id);
      return { deleted: true, unplanned: n };
    },
  },

  // ── modules (features) ──────────────────────────────────────────────────
  {
    name: "modules.list",
    description:
      "List a project's modules (features): status (planned / active / paused / shipped / cancelled), start → target dates and progress (done / total items). Each comes back with a `ref` (m1…) for tasks.create / tasks.update / modules.update.",
    input: z.object({
      project: z.string().optional().describe("Project NAME or key; omit for the focused project (or all projects)"),
      status: z.enum([...FEATURE_STATUSES, "live", "all"]).default("live").describe("'live' (default) = planned, active and paused"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const statuses =
        input.status === "all" ? undefined : input.status === "live" ? (["planned", "active", "paused"] as const) : ([input.status] as const);
      const rows = await ctx.db
        .select({
          id: features.id,
          name: features.name,
          project: projects.name,
          status: features.status,
          startAt: features.startAt,
          targetAt: features.targetAt,
          description: features.description,
        })
        .from(features)
        .innerJoin(projects, eq(projects.id, features.projectId))
        .where(and(p ? eq(features.projectId, p.id) : undefined, statuses ? inArray(features.status, [...statuses]) : undefined))
        .orderBy(asc(features.sortOrder), asc(features.createdAt));
      const progress = await moduleProgress(ctx.db, rows.map((r) => r.id));
      return registerRefs(
        ctx,
        "module",
        "m",
        rows.map((r) => ({
          ...r,
          description: r.description ? r.description.slice(0, 280) : null,
          items: progress.get(r.id)?.total ?? 0,
          done: progress.get(r.id)?.done ?? 0,
        })),
      );
    },
  },
  {
    name: "modules.create",
    description:
      "Create a module (feature) in a project — a deliverable that groups work items, with an optional start → target span. Starts 'planned'; it turns active on its own when an item moves.",
    input: z.object({
      name: z.string().min(1),
      project: z.string().optional().describe("Project NAME or key; omit for the focused project"),
      description: z.string().optional(),
      startAt: z.string().optional().describe("ISO 8601"),
      targetAt: z.string().optional().describe("Target date, ISO 8601"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (!p) return { error: "name the project (a module belongs to one)" };
      if ("error" in p) return p;
      const [dup] = await ctx.db
        .select({ id: features.id })
        .from(features)
        .where(and(eq(features.projectId, p.id), sql`lower(${features.name}) = ${input.name.trim().toLowerCase()}`));
      if (dup) return { error: `That project already has a module "${input.name.trim()}"` };
      const [{ next }] = await ctx.db
        .select({ next: sql<number>`coalesce(max(${features.sortOrder}) + 1, 0)` })
        .from(features)
        .where(eq(features.projectId, p.id));
      const [row] = await ctx.db
        .insert(features)
        .values({
          projectId: p.id,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          status: "planned",
          sortOrder: Number(next),
          startAt: dateOrNull(input.startAt) ?? null,
          targetAt: dateOrNull(input.targetAt) ?? null,
        })
        .returning();
      const [out] = registerRefs(ctx, "module", "m", [{ id: row.id, name: row.name, status: row.status }]);
      return { created: out };
    },
  },
  {
    name: "modules.update",
    description:
      "Edit a module (feature): name, description, dates, or status. A manual status (e.g. paused, cancelled, shipped) holds until its items move again. Pass only what changes; an empty string clears a date.",
    input: z.object({
      module: z.string().describe("Module ref ('m2') or NAME"),
      project: z.string().optional().describe("Its project NAME or key (needed with a NAME, unless you're focused on the project)"),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      status: z.enum(FEATURE_STATUSES).optional(),
      startAt: z.string().optional().describe("ISO 8601; empty string clears"),
      targetAt: z.string().optional().describe("ISO 8601; empty string clears"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const f = await resolveFeature(ctx, p?.id ?? null, input.module);
      if ("error" in f) return f;
      const id = f.ref.slice(9);
      const set = {
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        ...(input.status ? { status: input.status, shippedAt: input.status === "shipped" ? new Date() : null } : {}),
        ...(input.startAt !== undefined ? { startAt: dateOrNull(input.startAt) } : {}),
        ...(input.targetAt !== undefined ? { targetAt: dateOrNull(input.targetAt) } : {}),
      };
      if (!Object.keys(set).length) return { error: "nothing to update" };
      const [row] = await ctx.db.update(features).set({ ...set, updatedAt: new Date() }).where(eq(features.id, id)).returning({ name: features.name, status: features.status });
      return row ? { updated: row } : { error: "module not found" };
    },
  },
];
