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
import { createCycle, cycleGhosts, cycleStatus, ghostCount, deleteCycle, listCycles, rollOverCycle, updateCycle } from "./cycles";
import { identifierOf, projectKeyMap } from "./core";
import { resolveCycle, resolveFeature, resolveProject } from "./tools";
import { cycles, isClosed, TASK_STATUSES, tasks } from "./schema";
import { WEEK_START, WEEKDAY_LABELS } from "@/core/work-week";

const dateOrNull = (s: string | undefined) => (s === undefined ? undefined : s ? new Date(s) : null);
const errorOf = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

/**
 * Cycles follow the user's work week, so every one starts on WEEK_START
 * (Sunday). Judged on the calendar date as written ("2026-10-05…"), not the
 * UTC instant, so an offset can't flip the day. Returns the refusal, or null.
 */
function offWeekStart(startsAt: string): { error: string } | null {
  const ymd = /^\d{4}-\d{2}-\d{2}/.exec(startsAt)?.[0];
  if (!ymd) return null; // unparseable — parseRange reports it
  const d = new Date(`${ymd}T12:00:00Z`);
  const off = (d.getUTCDay() - WEEK_START + 7) % 7;
  if (!off) return null;
  const fix = new Date(+d - off * 86_400_000).toISOString().slice(0, 10);
  return {
    error: `Not saved: cycles start on a Sunday (the work week is Sun–Thu), and ${ymd} is a ${WEEKDAY_LABELS[off]}. Start it on ${fix} — a one-week cycle then ends on the Saturday, 6 days later.`,
  };
}

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
      "List cycles (time-boxed sprints) with their dates, status (upcoming / current / completed), progress and `ghosts` — how many members distort the figures (cycles.get names them). Each comes back with a `ref` (c1…) for cycles.get / tasks.create / tasks.update / cycles.update.",
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
          goal: c.goal,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          crossProject: !c.projectId,
          items: c.total,
          done: c.done,
          ghosts: c.ghosts,
        })),
      );
    },
  },
  {
    name: "cycles.get",
    description:
      "One cycle in full: goal, dates, status, progress, items per state, and its ghosts — the members its counts mislead about, each bucket with a count and the item identifiers: `cancelled` (members counted nowhere), `doneOutside` (done on a date outside the window that no cycle holds — a done item is otherwise filed under the cycle of its done date automatically), `undated` (open, no due date) and `dueOutside` (open, due before the cycle starts or after it ends).",
    input: z.object({
      cycle: z.string().describe("Cycle ref ('c1'), NAME, or 'current'"),
      project: z.string().optional().describe("Project NAME or key — picks among same-named or 'current' cycles"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const r = await resolveCycle(ctx, p?.id ?? null, input.cycle);
      if ("error" in r) return r;
      const [[c], members, keys] = await Promise.all([
        ctx.db.select().from(cycles).where(eq(cycles.id, r.id)),
        ctx.db.select().from(tasks).where(eq(tasks.cycleId, r.id)),
        projectKeyMap(ctx.db),
      ]);
      if (!c) return { error: "cycle not found" };
      const [project] = c.projectId ? await ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, c.projectId)) : [];
      const counted = members.filter((m) => m.status !== "cancelled");
      const done = counted.filter((m) => isClosed(m.status));
      const name = new Map(members.map((m) => [m.id, identifierOf(m, keys) ?? m.title]));
      const g = cycleGhosts(c, members);
      const bucket = (ids: string[]) => ({ count: ids.length, items: ids.map((id) => name.get(id)!) });
      const [row] = registerRefs(ctx, "cycle", "c", [{ id: c.id, name: c.name }]);
      return {
        ...row,
        project: project?.name ?? null,
        status: cycleStatus(c),
        goal: c.goal,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        items: counted.length,
        done: done.length,
        points: counted.reduce((n, m) => n + (m.estimate ?? 0), 0),
        pointsDone: done.reduce((n, m) => n + (m.estimate ?? 0), 0),
        byStatus: Object.fromEntries(TASK_STATUSES.map((s) => [s, members.filter((m) => m.status === s).length]).filter(([, n]) => n)),
        ghosts: {
          total: ghostCount(g),
          cancelled: bucket(g.cancelled),
          doneOutside: bucket(g.doneOutside),
          undated: bucket(g.undated),
          dueOutside: bucket(g.dueOutside),
        },
      };
    },
  },
  {
    name: "cycles.create",
    description:
      "Create a cycle (sprint) with a start and end date, for one project (or cross-project when no project applies). Cycles are whole calendar weeks: each starts on a Sunday and a one-week cycle spans Sunday → Saturday (work days Sun–Thu, weekend Fri–Sat).",
    input: z.object({
      name: z.string().min(1),
      startsAt: z.string().describe("Start date, ISO 8601 — a Sunday"),
      endsAt: z.string().describe("End date, ISO 8601"),
      goal: z.string().optional().describe("What the cycle commits to — its outcome (markdown)"),
      project: z.string().optional().describe("Project NAME or key; omit for the focused project, or a cross-project cycle"),
    }),
    async execute(input, ctx) {
      const wrongDay = offWeekStart(input.startsAt);
      if (wrongDay) return wrongDay;
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      try {
        const c = await createCycle(ctx.db, { name: input.name, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), goal: input.goal, projectId: p?.id ?? null });
        const [row] = registerRefs(ctx, "cycle", "c", [{ id: c.id, name: c.name, status: cycleStatus(c) }]);
        return { created: { ...row, ...(c.goal ? { goal: c.goal } : {}) } };
      } catch (e) {
        return errorOf(e);
      }
    },
  },
  {
    name: "cycles.update",
    description: "Rename a cycle, set its goal or change its dates (a cycle starts on a Sunday). Pass only what changes.",
    input: z.object({
      cycle: z.string().describe("Cycle ref ('c1'), NAME, or 'current'"),
      name: z.string().min(1).optional(),
      startsAt: z.string().optional().describe("ISO 8601"),
      endsAt: z.string().optional().describe("ISO 8601"),
      goal: z.string().optional().describe("What the cycle commits to (markdown); empty string clears it"),
      project: z.string().optional().describe("Project NAME or key — picks among same-named or 'current' cycles"),
    }),
    async execute(input, ctx) {
      const wrongDay = input.startsAt ? offWeekStart(input.startsAt) : null;
      if (wrongDay) return wrongDay;
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const c = await resolveCycle(ctx, p?.id ?? null, input.cycle);
      if ("error" in c) return c;
      try {
        await updateCycle(ctx.db, c.id, {
          name: input.name,
          startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
          endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
          goal: input.goal,
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
      "List a project's modules (features): status (planned / active / paused / shipped / cancelled), start → target dates and progress (done / total items). Each comes back with a `ref` (m1…) for tasks.create / tasks.update / modules.update. A description longer than 280 characters is cut (descriptionTruncated: true) — modules.get returns it whole.",
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
          ...((r.description?.length ?? 0) > 280 ? { descriptionTruncated: true } : {}),
          items: progress.get(r.id)?.total ?? 0,
          done: progress.get(r.id)?.done ?? 0,
        })),
      );
    },
  },
  {
    name: "modules.get",
    description: "One module (feature) in full: its whole description, status, start → target dates and progress (done / total items, by state).",
    input: z.object({
      module: z.string().describe("Module ref ('m2') or NAME"),
      project: z.string().optional().describe("Its project NAME or key (needed with a NAME, unless you're focused on the project)"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const f = await resolveFeature(ctx, p?.id ?? null, input.module);
      if ("error" in f) return f;
      const id = f.ref.slice(9);
      const [row] = await ctx.db
        .select({
          id: features.id,
          name: features.name,
          project: projects.name,
          status: features.status,
          description: features.description,
          startAt: features.startAt,
          targetAt: features.targetAt,
          shippedAt: features.shippedAt,
          updatedAt: features.updatedAt,
        })
        .from(features)
        .innerJoin(projects, eq(projects.id, features.projectId))
        .where(eq(features.id, id));
      if (!row) return { error: "module not found" };
      const members = await ctx.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.featureRef, f.ref));
      const [out] = registerRefs(ctx, "module", "m", [row]);
      return {
        ...out,
        items: members.filter((m) => m.status !== "cancelled").length,
        done: members.filter((m) => m.status === "done").length,
        byStatus: Object.fromEntries(TASK_STATUSES.map((s) => [s, members.filter((m) => m.status === s).length]).filter(([, n]) => n)),
      };
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
      "Edit a module (feature): name, description, dates, or status. A manual status (e.g. paused, cancelled, shipped) holds until its items move again. Pass only what changes; an empty string clears a date. " +
      "`description` replaces the whole text; `prependDescription` / `appendDescription` add to it verbatim (include your own separator, e.g. a trailing space or newline).",
    input: z.object({
      module: z.string().describe("Module ref ('m2') or NAME"),
      project: z.string().optional().describe("Its project NAME or key (needed with a NAME, unless you're focused on the project)"),
      name: z.string().min(1).optional(),
      description: z.string().optional().describe("The new description, replacing the old; empty string clears"),
      prependDescription: z.string().min(1).optional().describe("Text put before the current description, verbatim"),
      appendDescription: z.string().min(1).optional().describe("Text put after the current description, verbatim"),
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
      const edits = input.prependDescription !== undefined || input.appendDescription !== undefined;
      if (edits && input.description !== undefined) return { error: "pass description (replace) or prepend/appendDescription, not both" };
      const set = {
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        // In the database, so a write that landed in between is kept, never overwritten blind.
        ...(edits
          ? { description: sql`nullif(btrim(${input.prependDescription ?? ""} || coalesce(${features.description}, '') || ${input.appendDescription ?? ""}), '')` }
          : {}),
        ...(input.status ? { status: input.status, shippedAt: input.status === "shipped" ? new Date() : null } : {}),
        ...(input.startAt !== undefined ? { startAt: dateOrNull(input.startAt) } : {}),
        ...(input.targetAt !== undefined ? { targetAt: dateOrNull(input.targetAt) } : {}),
      };
      if (!Object.keys(set).length) return { error: "nothing to update" };
      const [row] = await ctx.db.update(features).set({ ...set, updatedAt: new Date() }).where(eq(features.id, id)).returning({ name: features.name, status: features.status, description: features.description });
      if (!row) return { error: "module not found" };
      return { updated: edits ? row : { name: row.name, status: row.status } };
    },
  },
];
