/**
 * Agent tools for milestones — a project's named product stages (Visibility,
 * MVP, …) built from capabilities and delivery content: whole modules, single
 * work items (from partly-in-scope modules too), other milestones, and any
 * other apOS entity. Same conventions as tools.ts: entities are targeted by
 * list refs (ms1, m2, t3), identifiers (ETHOS-12) or names, never raw ids.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { registerRefs } from "@/core/ai/refs";
import { searchIndex } from "@/core/db/schema/search-index";
import { features } from "@/modules/projects/schema";
import { listWorkItems, type WorkItem } from "./core";
import { milestoneResolver, milestoneStats, OUTLOOK_META, orderMilestones, type MilestoneBundle, type MilestoneInfo } from "./milestone-scope";
import { deleteMilestone, ensureCapability, loadMilestoneBundle, removeContent, upsertContent } from "./milestones";
import { MILESTONE_STATUSES, milestoneCapabilities, milestones, type MilestoneCriterion } from "./schema";
import { resolveFeature, resolveProject } from "./tools";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateOrNull = (s: string | undefined) => (s === undefined ? undefined : s ? new Date(s) : null);
const day = (d: Date | number | null) => (d == null ? null : new Date(d).toISOString().slice(0, 10));
const lower = (s: string) => s.trim().toLowerCase();

type Found = { m: MilestoneInfo; bundle: MilestoneBundle };

/**
 * A milestone by its list ref (ms1) or NAME. Without a project, a name is
 * looked up across projects and must be unambiguous.
 */
async function findMilestone(ctx: AiToolContext, project: string | undefined, key: string): Promise<Found | { error: string }> {
  const p = await resolveProject(ctx, project);
  if (p && "error" in p) return p;
  const k = key.trim();
  const refHit = /^ms\d+$/i.test(k) ? ctx.refs?.[k.toLowerCase()] : undefined;
  if (/^ms\d+$/i.test(k) && (!refHit || refHit.kind !== "milestone")) return { error: `Unknown milestone ref "${k}" — list milestones first` };
  const bundle = await loadMilestoneBundle(ctx.db, p?.id);
  const hits = bundle.milestones.filter((m) => (refHit ? m.id === refHit.id : UUID_RE.test(k) ? m.id === k : lower(m.name) === lower(k)));
  if (refHit && !hits.length) {
    // A ref from another project's listing: load that one's project.
    const all = await loadMilestoneBundle(ctx.db);
    const m = all.milestones.find((x) => x.id === refHit.id);
    if (!m) return { error: `Milestone "${k}" no longer exists` };
    return { m, bundle: await loadMilestoneBundle(ctx.db, m.projectId) };
  }
  if (!hits.length) return { error: `No milestone "${k}"${p ? " in that project" : ""}` };
  if (hits.length > 1) return { error: `"${k}" names milestones in several projects — pass the project` };
  return { m: hits[0], bundle: p ? bundle : await loadMilestoneBundle(ctx.db, hits[0].projectId) };
}

/** The project's work items keyed by identifier and id, for resolving content. */
async function projectItems(ctx: AiToolContext, projectId: string) {
  const items = await listWorkItems(ctx.db, { projectId, notes: false });
  const byKey = new Map<string, WorkItem>();
  for (const t of items) {
    byKey.set(t.id, t);
    if (t.identifier) byKey.set(t.identifier.toUpperCase(), t);
  }
  return { items, byKey };
}

type Target = { kind: "module" | "item" | "milestone" | "entity"; targetId: string; entityKind?: string | null; label?: string | null };

/** Turn the tool's content lists into content rows, all checked against the milestone's project. */
async function resolveTargets(
  ctx: AiToolContext,
  f: Found,
  input: { modules?: string[]; items?: string[]; milestones?: string[]; entities?: { kind: string; id?: string; title?: string }[] },
): Promise<{ targets: Target[] } | { error: string }> {
  const { m, bundle } = f;
  const targets: Target[] = [];
  const errors: string[] = [];
  for (const name of input.modules ?? []) {
    const r = await resolveFeature(ctx, m.projectId, name);
    if ("error" in r) errors.push(r.error);
    else {
      const id = r.ref.slice(9);
      const [own] = await ctx.db.select({ id: features.id }).from(features).where(and(eq(features.id, id), eq(features.projectId, m.projectId)));
      if (own) targets.push({ kind: "module", targetId: id });
      else errors.push(`Module "${name}" belongs to another project`);
    }
  }
  if (input.items?.length) {
    const { byKey } = await projectItems(ctx, m.projectId);
    for (const key of input.items) {
      const k = key.trim();
      const ref = ctx.refs?.[k];
      const t = ref?.kind === "task" ? byKey.get(ref.id) : byKey.get(k.toUpperCase()) ?? byKey.get(k);
      if (t) targets.push({ kind: "item", targetId: t.id });
      else errors.push(ref ? `Item "${k}" is in another project` : `No work item "${k}" in this project`);
    }
  }
  for (const key of input.milestones ?? []) {
    const k = key.trim();
    const ref = ctx.refs?.[k.toLowerCase()];
    const hit = bundle.milestones.find((x) => (ref?.kind === "milestone" ? x.id === ref.id : lower(x.name) === lower(k)));
    if (!hit) errors.push(`No milestone "${k}" in this project`);
    else if (hit.id === m.id) errors.push("A milestone can't contain itself");
    else targets.push({ kind: "milestone", targetId: hit.id });
  }
  for (const e of input.entities ?? []) {
    const kind = e.kind.trim().toLowerCase();
    const rows = await ctx.db
      .select({ sourceId: searchIndex.sourceId, title: searchIndex.title })
      .from(searchIndex)
      .where(
        and(
          eq(searchIndex.kind, kind),
          e.id ? eq(searchIndex.sourceId, e.id.trim()) : e.title ? sql`${searchIndex.title} ilike ${`%${e.title.trim()}%`}` : sql`false`,
        ),
      )
      .limit(6);
    const exact = rows.filter((r) => e.title && lower(r.title) === lower(e.title));
    const pick = rows.length === 1 ? rows[0] : exact.length === 1 ? exact[0] : null;
    if (pick) targets.push({ kind: "entity", targetId: pick.sourceId, entityKind: kind, label: pick.title });
    else if (!rows.length) errors.push(`No ${kind} matching "${e.id ?? e.title ?? ""}"`);
    else errors.push(`"${e.title}" matches several ${kind}s: ${rows.map((r) => `"${r.title}" (id ${r.sourceId})`).join(", ")} — pass the id`);
  }
  return errors.length ? { error: errors.join("; ") } : { targets };
}

/** Put `id` right after `after` (or first when after = "start") in the project's order. */
async function place(ctx: AiToolContext, projectId: string, id: string, after: string) {
  const bundle = await loadMilestoneBundle(ctx.db, projectId);
  const order = orderMilestones(bundle.milestones).map((x) => x.id).filter((x) => x !== id);
  let at = 0;
  if (lower(after) !== "start") {
    const ref = ctx.refs?.[lower(after)];
    const prev = bundle.milestones.find((x) => (ref?.kind === "milestone" ? x.id === ref.id : lower(x.name) === lower(after)));
    if (!prev) return { error: `No milestone "${after}" to place it after` };
    at = order.indexOf(prev.id) + 1;
  }
  order.splice(at, 0, id);
  await Promise.all(order.map((mid, i) => ctx.db.update(milestones).set({ sortOrder: i }).where(eq(milestones.id, mid))));
  return null;
}

async function requiresIds(ctx: AiToolContext, projectId: string, self: string | null, names: string[]) {
  const bundle = await loadMilestoneBundle(ctx.db, projectId);
  const ids: string[] = [];
  for (const n of names) {
    const ref = ctx.refs?.[lower(n)];
    const hit = bundle.milestones.find((x) => (ref?.kind === "milestone" ? x.id === ref.id : lower(x.name) === lower(n)));
    if (!hit) return { error: `No milestone "${n}" in this project to require` };
    if (hit.id === self) return { error: "A milestone can't require itself" };
    ids.push(hit.id);
  }
  return { ids };
}

const contentLists = {
  modules: z.array(z.string()).optional().describe("Whole modules, by ref ('m2') or NAME — every item filed in them counts, now and later"),
  items: z.array(z.string()).optional().describe("Single work items (tasks, bugs, phases…), by identifier ('ETHOS-12') or ref ('t3') — use for modules only partly in scope"),
  milestones: z.array(z.string()).optional().describe("Other milestones whose whole scope this one contains, by ref ('ms1') or NAME"),
  entities: z
    .array(z.object({ kind: z.string().describe("note, knowledge, idea, workbench, file, vault, notion, event, …"), id: z.string().optional(), title: z.string().optional() }))
    .optional()
    .describe("Any other apOS entity as a single deliverable, by id or (unique) title"),
};

export const milestoneTools: AiToolDef[] = [
  {
    name: "milestones.list",
    description:
      "List a project's milestones (named product stages, e.g. Visibility → MVP) in roadmap order: status, target date, progress (done / total units), forecast, outlook (on track / at risk / late…), and what each is waiting on. Each comes back with a `ref` (ms1…).",
    input: z.object({
      project: z.string().optional().describe("Project NAME or key; omit for the focused project (or all projects)"),
      status: z.enum([...MILESTONE_STATUSES, "live", "all"]).default("live").describe("'live' (default) = planned and active"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (p && "error" in p) return p;
      const bundle = await loadMilestoneBundle(ctx.db, p?.id);
      const items = p ? await listWorkItems(ctx.db, { projectId: p.id, notes: false }) : await listWorkItems(ctx.db, { notes: false });
      const resolve = milestoneResolver(bundle, items);
      const now = Date.now();
      const rows = orderMilestones(bundle.milestones)
        .filter((m) => input.status === "all" || (input.status === "live" ? m.status === "planned" || m.status === "active" : m.status === input.status))
        .map((m) => {
          const s = milestoneStats(m, bundle, resolve, now);
          return {
            id: m.id,
            name: m.name,
            status: m.status,
            targetAt: day(m.targetAt),
            progress: `${s.done}/${s.total} (${s.pct}%)`,
            forecast: day(s.forecastAt),
            outlook: OUTLOOK_META[s.outlook].label,
            capabilities: s.capabilities.map((c) => `${c.name} ${c.done}/${c.total}`),
            criteria: s.criteria.total ? `${s.criteria.done}/${s.criteria.total}` : null,
            waitingOn: s.waitingOn.map((w) => `${w.name} (${w.pct}%)`),
          };
        });
      return registerRefs(ctx, "milestone", "ms", rows);
    },
  },
  {
    name: "milestones.get",
    description:
      "One milestone in full: goal, target and forecast, exit criteria, each capability with its progress and content (modules, items, nested milestones, entities, exclusions), and the open work still left.",
    input: z.object({
      milestone: z.string().describe("Milestone ref ('ms1') or NAME"),
      project: z.string().optional().describe("Its project NAME or key (needed with a NAME used in several projects)"),
      remaining: z.number().int().min(0).max(200).default(40).describe("How many open items to list (0 = none)"),
    }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      const { m, bundle } = f;
      const [items, feats] = await Promise.all([
        listWorkItems(ctx.db, { projectId: m.projectId, notes: false }),
        ctx.db.select({ id: features.id, name: features.name }).from(features).where(eq(features.projectId, m.projectId)),
      ]);
      const resolve = milestoneResolver(bundle, items);
      const s = milestoneStats(m, bundle, resolve, Date.now());
      const itemById = new Map(items.map((t) => [t.id, t]));
      const featName = new Map(feats.map((x) => [x.id, x.name]));
      const msName = new Map(bundle.milestones.map((x) => [x.id, x.name]));
      const rows = bundle.content.filter((r) => r.milestoneId === m.id);
      const capIds = new Set(bundle.capabilities.filter((c) => c.milestoneId === m.id).map((c) => c.id));
      const describe = (r: (typeof rows)[number]) => {
        const what =
          r.kind === "module"
            ? `module "${featName.get(r.targetId) ?? "?"}"`
            : r.kind === "item"
              ? `${itemById.get(r.targetId)?.identifier ?? "item"} ${itemById.get(r.targetId)?.title.slice(0, 90) ?? "(not found)"}`
              : r.kind === "milestone"
                ? `milestone "${msName.get(r.targetId) ?? "?"}"`
                : `${r.entityKind} "${r.label ?? r.targetId}"${r.done ? " ✓" : ""}`;
        return r.exclude ? `EXCLUDED ${what}` : what;
      };
      const [me] = registerRefs(ctx, "milestone", "ms", [{ id: m.id, name: m.name }]);
      const open = resolve(m.id).items.filter((x) => x.item.status !== "done").map((x) => x.item);
      return {
        ref: me.ref,
        name: m.name,
        status: m.status,
        goal: m.description,
        targetAt: day(m.targetAt),
        progress: { done: s.done, total: s.total, pct: s.pct, byState: s.by },
        pacePerDay: Math.round(s.pace * 100) / 100,
        forecast: day(s.forecastAt),
        outlook: OUTLOOK_META[s.outlook].label,
        waitingOn: s.waitingOn,
        criteria: m.criteria.map((c, i) => `${i + 1}. [${c.done ? "x" : " "}] ${c.text}`),
        capabilities: s.capabilities.map((c) => ({
          name: c.name,
          description: c.description,
          progress: `${c.done}/${c.total}`,
          content: rows.filter((r) => !r.exclude && (c.id ? r.capabilityId === c.id : !r.capabilityId || !capIds.has(r.capabilityId))).map(describe),
        })),
        excluded: rows.filter((r) => r.exclude).map(describe),
        remaining: open
          .sort((a, b) => ["review", "doing", "todo", "backlog"].indexOf(a.status) - ["review", "doing", "todo", "backlog"].indexOf(b.status))
          .slice(0, input.remaining)
          .map((t) => ({ identifier: t.identifier, title: t.title.slice(0, 120), status: t.status })),
        remainingTotal: open.length,
      };
    },
  },
  {
    name: "milestones.create",
    description:
      "Create a milestone — a named product stage in one project (e.g. 'Visibility', 'MVP'). Then fill it with milestones.addContent. `requires` names the milestones that must be reached first; `after` places it in the roadmap order.",
    input: z.object({
      name: z.string().min(1),
      project: z.string().optional().describe("Project NAME or key; omit for the focused project"),
      description: z.string().optional().describe("The goal — what reaching this stage means (markdown)"),
      targetAt: z.string().optional().describe("Target date, ISO 8601"),
      requires: z.array(z.string()).optional().describe("Milestones (ref or NAME) that must be reached first"),
      after: z.string().optional().describe("Milestone (ref or NAME) it comes after in the roadmap, or 'start'; default: last"),
    }),
    async execute(input, ctx) {
      const p = await resolveProject(ctx, input.project);
      if (!p) return { error: "name the project (a milestone belongs to one)" };
      if ("error" in p) return p;
      const bundle = await loadMilestoneBundle(ctx.db, p.id);
      if (bundle.milestones.some((m) => lower(m.name) === lower(input.name))) return { error: `That project already has a milestone "${input.name.trim()}"` };
      const req = await requiresIds(ctx, p.id, null, input.requires ?? []);
      if ("error" in req) return req;
      const [row] = await ctx.db
        .insert(milestones)
        .values({
          projectId: p.id,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          targetAt: dateOrNull(input.targetAt) ?? null,
          requires: req.ids,
          sortOrder: bundle.milestones.length ? Math.max(...bundle.milestones.map((m) => m.sortOrder)) + 1 : 0,
        })
        .returning();
      if (input.after) {
        const err = await place(ctx, p.id, row.id, input.after);
        if (err) return err;
      }
      const [out] = registerRefs(ctx, "milestone", "ms", [{ id: row.id, name: row.name, status: row.status }]);
      return { created: out };
    },
  },
  {
    name: "milestones.update",
    description:
      "Edit a milestone: rename it, change its goal, target date, status (planned / active / done / cancelled), what it requires first, or its place in the roadmap. Pass only what changes; an empty string clears the target.",
    input: z.object({
      milestone: z.string().describe("Milestone ref ('ms1') or NAME"),
      project: z.string().optional(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      status: z.enum(MILESTONE_STATUSES).optional(),
      targetAt: z.string().optional().describe("ISO 8601; empty string clears"),
      requires: z.array(z.string()).optional().describe("REPLACES the list of milestones that must be reached first ([] clears)"),
      after: z.string().optional().describe("Move it after this milestone in the roadmap, or 'start'"),
    }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      const { m, bundle } = f;
      if (input.name && lower(input.name) !== lower(m.name) && bundle.milestones.some((x) => lower(x.name) === lower(input.name!)))
        return { error: `That project already has a milestone "${input.name.trim()}"` };
      let requires: string[] | undefined;
      if (input.requires) {
        const req = await requiresIds(ctx, m.projectId, m.id, input.requires);
        if ("error" in req) return req;
        requires = req.ids;
      }
      const set = {
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        ...(input.status ? { status: input.status, doneAt: input.status === "done" ? new Date() : null } : {}),
        ...(input.targetAt !== undefined ? { targetAt: dateOrNull(input.targetAt) } : {}),
        ...(requires ? { requires } : {}),
      };
      if (!Object.keys(set).length && !input.after) return { error: "nothing to update" };
      if (Object.keys(set).length) await ctx.db.update(milestones).set({ ...set, updatedAt: new Date() }).where(eq(milestones.id, m.id));
      if (input.after) {
        const err = await place(ctx, m.projectId, m.id, input.after);
        if (err) return err;
      }
      return { updated: { name: set.name ?? m.name, status: set.status ?? m.status } };
    },
  },
  {
    name: "milestones.delete",
    description:
      "Delete a milestone with its capabilities, content list and criteria. The work it points at (modules, items, other milestones, entities) is never deleted.",
    risk: "approval",
    input: z.object({ milestone: z.string().describe("Milestone ref ('ms1') or NAME"), project: z.string().optional() }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      await deleteMilestone(ctx.db, f.m.id);
      return { deleted: f.m.name };
    },
  },
  {
    name: "milestones.addContent",
    description:
      "Add delivery content to a milestone — whole modules, single work items (for a module only partly in scope, add its items instead of the module), other milestones, or any other apOS entity — optionally under a named capability (created if new). Re-adding existing content updates it: moves it to `capability`, or sets `exclude` / `done`. `exclude: true` takes modules or items OUT of scope (e.g. a whole module except one item).",
    input: z.object({
      milestone: z.string().describe("Milestone ref ('ms1') or NAME"),
      project: z.string().optional(),
      capability: z.string().optional().describe("Capability NAME to file the content under; created when new"),
      ...contentLists,
      exclude: z.boolean().optional().describe("true = these modules/items are excluded from scope"),
      done: z.boolean().optional().describe("For entities: mark the deliverable done (work items and modules track their own state)"),
    }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      const r = await resolveTargets(ctx, f, input);
      if ("error" in r) return r;
      if (!r.targets.length) return { error: "no content given — pass modules, items, milestones or entities" };
      if (input.exclude && r.targets.some((t) => t.kind === "milestone" || t.kind === "entity"))
        return { error: "only modules and items can be excluded — remove a milestone or entity with milestones.removeContent" };
      const capabilityId = input.capability?.trim() ? await ensureCapability(ctx.db, f.m.id, input.capability) : undefined;
      const n = await upsertContent(ctx.db, f.m.id, r.targets, { capabilityId, exclude: input.exclude, done: input.done });
      return { added: n, milestone: f.m.name, ...(input.capability?.trim() ? { capability: input.capability.trim() } : {}) };
    },
  },
  {
    name: "milestones.removeContent",
    description: "Remove content rows (modules, items, milestones, entities — including exclusions) from a milestone. The work itself is untouched.",
    input: z.object({ milestone: z.string().describe("Milestone ref ('ms1') or NAME"), project: z.string().optional(), ...contentLists }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      const r = await resolveTargets(ctx, f, input);
      if ("error" in r) return r;
      return { removed: await removeContent(ctx.db, f.m.id, r.targets) };
    },
  },
  {
    name: "milestones.capability",
    description:
      "Create or edit a capability of a milestone (a named group of its content, e.g. 'AI visibility'): rename it, describe it, move it after another, or delete it (its content stays in the milestone, ungrouped).",
    input: z.object({
      milestone: z.string().describe("Milestone ref ('ms1') or NAME"),
      project: z.string().optional(),
      name: z.string().min(1).describe("The capability's NAME (created when new)"),
      rename: z.string().min(1).optional(),
      description: z.string().optional(),
      after: z.string().optional().describe("Capability NAME it comes after, or 'start'"),
      delete: z.boolean().optional(),
    }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      const caps = f.bundle.capabilities.filter((c) => c.milestoneId === f.m.id).sort((a, b) => a.sortOrder - b.sortOrder);
      const hit = caps.find((c) => lower(c.name) === lower(input.name));
      if (input.delete) {
        if (!hit) return { error: `No capability "${input.name}"` };
        await ctx.db.execute(sql`update milestone_content set capability_id = null where capability_id = ${hit.id}`);
        await ctx.db.delete(milestoneCapabilities).where(eq(milestoneCapabilities.id, hit.id));
        return { deleted: hit.name };
      }
      const id = hit?.id ?? (await ensureCapability(ctx.db, f.m.id, input.name));
      if (input.rename || input.description !== undefined)
        await ctx.db
          .update(milestoneCapabilities)
          .set({
            ...(input.rename ? { name: input.rename.trim() } : {}),
            ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
          })
          .where(eq(milestoneCapabilities.id, id));
      if (input.after) {
        const order = caps.map((c) => c.id).filter((c) => c !== id);
        let at = 0;
        if (lower(input.after) !== "start") {
          const prev = caps.find((c) => lower(c.name) === lower(input.after!));
          if (!prev) return { error: `No capability "${input.after}"` };
          at = order.indexOf(prev.id) + 1;
        }
        order.splice(at, 0, id);
        await Promise.all(order.map((cid, i) => ctx.db.update(milestoneCapabilities).set({ sortOrder: i }).where(eq(milestoneCapabilities.id, cid))));
      }
      return { [hit ? "updated" : "created"]: (input.rename ?? input.name).trim() };
    },
  },
  {
    name: "milestones.criteria",
    description:
      "Edit a milestone's exit criteria — the conditions besides its content that must hold to call it reached. Add new ones, check / uncheck / remove existing ones by number (1-based, as milestones.get lists them) or exact text.",
    input: z.object({
      milestone: z.string().describe("Milestone ref ('ms1') or NAME"),
      project: z.string().optional(),
      add: z.array(z.string().min(1)).optional(),
      check: z.array(z.string()).optional(),
      uncheck: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      const f = await findMilestone(ctx, input.project, input.milestone);
      if ("error" in f) return f;
      const list: MilestoneCriterion[] = f.m.criteria.map((c) => ({ ...c }));
      const find = (k: string) => (/^\d+$/.test(k.trim()) ? list[Number(k) - 1] : list.find((c) => lower(c.text) === lower(k)));
      const missing: string[] = [];
      const mark = (keys: string[] | undefined, done: boolean) => {
        for (const k of keys ?? []) {
          const c = find(k);
          if (c) c.done = done;
          else missing.push(k);
        }
      };
      mark(input.check, true);
      mark(input.uncheck, false);
      const drop = new Set((input.remove ?? []).map((k: string) => find(k)?.id ?? (missing.push(k), "")));
      if (missing.length) return { error: `No criterion ${missing.map((k) => `"${k}"`).join(", ")}` };
      const next = [...list.filter((c) => !drop.has(c.id)), ...(input.add ?? []).map((text: string) => ({ id: randomUUID(), text: text.trim(), done: false }))];
      await ctx.db.update(milestones).set({ criteria: next, updatedAt: new Date() }).where(eq(milestones.id, f.m.id));
      return { criteria: next.map((c, i) => `${i + 1}. [${c.done ? "x" : " "}] ${c.text}`) };
    },
  },
];
