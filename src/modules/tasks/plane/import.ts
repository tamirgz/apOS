/**
 * Plane → apOS importer. Two passes the user drives from the Work page:
 *   preview — read-only: which Plane projects exist, what they'd map to, how
 *             many items are new vs already imported
 *   import  — for the chosen projects: modules → features, cycles → cycles,
 *             work items → items (state/priority/labels/dates/description),
 *             then parents. Idempotent via externalRef, so re-running is a
 *             sync: changed fields update (and show in the item's activity).
 *
 * Not imported (v1): comments, relations, assignees, estimates (Plane exposes
 * only an estimate-point id). Runs in the worker (rate limit 60 req/min);
 * progress lives in app_settings "plane_import_status" for the UI to poll.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { setSetting } from "@/core/app-settings";
import { features, projects } from "@/modules/projects/schema";
import { addComment, createWorkItem, syncFeatureStatus, updateWorkItem, type WorkItemPatch } from "../core";
import { createCycle } from "../cycles";
import { normalizeKey } from "../keys";
import { cycles, tasks } from "../schema";
import { listAll, type PlaneTransport } from "./client";
import {
  htmlToText,
  labelNames,
  mapModuleStatus,
  mapPriority,
  mapState,
  planeDate,
  type PlaneCycle,
  type PlaneLabel,
  type PlaneModule,
  type PlaneProject,
  type PlaneState,
  type PlaneWorkItem,
} from "./map";

export const PLANE_STATUS_KEY = "plane_import_status";
const ACTOR = "system:plane";

export interface PlanePlanRow {
  planeId: string;
  name: string;
  identifier: string;
  archived: boolean;
  /** Local project it maps to, or null = would be created. */
  localId: string | null;
  localName: string | null;
  items: number;
  newItems: number;
  modules: number;
  cycles: number;
}

export interface PlaneImportStatus {
  state: "running" | "done" | "failed";
  mode: "preview" | "import";
  startedAt: string;
  /** Last progress write — a running status that stops updating is dead. */
  updatedAt?: string;
  finishedAt?: string;
  step: string;
  log: string[];
  plan?: PlanePlanRow[];
  result?: { projects: number; created: number; updated: number; features: number; cycles: number };
  error?: string;
}

export class Progress {
  status: PlaneImportStatus;
  constructor(mode: PlaneImportStatus["mode"], private persist = true) {
    this.status = { state: "running", mode, startedAt: new Date().toISOString(), step: "starting", log: [] };
  }
  async step(msg: string) {
    this.status.step = msg;
    this.status.log = [...this.status.log, `${new Date().toISOString().slice(11, 19)} ${msg}`].slice(-40);
    console.log(`[plane] ${msg}`);
    await this.save();
  }
  async save() {
    this.status.updatedAt = new Date().toISOString();
    if (this.persist) await setSetting(PLANE_STATUS_KEY, JSON.stringify(this.status));
  }
}

const itemsPath = (pid: string) => `/projects/${pid}/work-items/`;

async function matchLocalProject(db: Db, p: PlaneProject) {
  const key = normalizeKey(p.identifier);
  const [byKey] = key ? await db.select().from(projects).where(eq(projects.key, key)) : [];
  if (byKey) return byKey;
  const [byName] = await db
    .select()
    .from(projects)
    .where(sql`lower(${projects.name}) = ${p.name.trim().toLowerCase()}`);
  return byName ?? null;
}

async function existingRefs(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ ref: tasks.externalRef })
    .from(tasks)
    .where(sql`${tasks.externalRef} like 'plane:%'`);
  return new Set(rows.map((r) => r.ref!));
}

export async function previewPlane(db: Db, get: PlaneTransport, progress: Progress): Promise<PlanePlanRow[]> {
  await progress.step("listing Plane projects");
  const planeProjects = await listAll<PlaneProject>(get, "/projects/");
  const refs = await existingRefs(db);
  const plan: PlanePlanRow[] = [];
  for (const p of planeProjects) {
    const archived = !!p.archived_at;
    const local = await matchLocalProject(db, p);
    let items: PlaneWorkItem[] = [];
    let modules = 0;
    let cycleCount = 0;
    if (!archived) {
      await progress.step(`reading ${p.identifier}`);
      items = (await listAll<PlaneWorkItem>(get, itemsPath(p.id))).filter((i) => !i.is_draft && !i.archived_at);
      modules = (await listAll<PlaneModule>(get, `/projects/${p.id}/modules/`)).filter((m) => !m.archived_at).length;
      cycleCount = (await listAll<PlaneCycle>(get, `/projects/${p.id}/cycles/`)).filter(
        (c) => !c.archived_at && c.start_date && c.end_date,
      ).length;
    }
    plan.push({
      planeId: p.id,
      name: p.name,
      identifier: p.identifier,
      archived,
      localId: local?.id ?? null,
      localName: local?.name ?? null,
      items: items.length,
      newItems: items.filter((i) => !refs.has(`plane:${i.id}`)).length,
      modules,
      cycles: cycleCount,
    });
  }
  return plan;
}

async function ensureLocalProject(db: Db, p: PlaneProject) {
  const local = await matchLocalProject(db, p);
  if (local) return { project: local, created: false };
  const key = normalizeKey(p.identifier);
  const [taken] = key ? await db.select({ id: projects.id }).from(projects).where(eq(projects.key, key)) : [];
  const [row] = await db
    .insert(projects)
    .values({ name: p.name.trim(), description: p.description?.trim() || null, key: key && !taken ? key : null })
    .returning();
  return { project: row, created: true };
}

async function upsertFeature(db: Db, projectId: string, m: PlaneModule): Promise<string> {
  const ref = `plane-module:${m.id}`;
  const [cur] = await db.select().from(features).where(eq(features.externalRef, ref));
  const fields = {
    name: m.name.trim(),
    description: m.description?.trim() || null,
    targetAt: planeDate(m.target_date),
  };
  if (cur) {
    await db.update(features).set({ ...fields, updatedAt: new Date() }).where(eq(features.id, cur.id));
    return cur.id;
  }
  const status = mapModuleStatus(m.status);
  const [row] = await db
    .insert(features)
    .values({ ...fields, projectId, status, externalRef: ref, shippedAt: status === "shipped" ? new Date() : null })
    .returning();
  return row.id;
}

async function upsertCycle(db: Db, projectId: string, c: PlaneCycle): Promise<string | null> {
  const startsAt = planeDate(c.start_date);
  const endsAt = planeDate(c.end_date);
  if (!startsAt || !endsAt) return null; // draft cycle — nothing to plan against
  const ref = `plane-cycle:${c.id}`;
  const [cur] = await db.select().from(cycles).where(eq(cycles.externalRef, ref));
  if (cur) {
    await db.update(cycles).set({ name: c.name.trim(), startsAt, endsAt }).where(eq(cycles.id, cur.id));
    return cur.id;
  }
  return (await createCycle(db, { name: c.name, startsAt, endsAt, projectId, externalRef: ref })).id;
}

export async function importPlane(
  db: Db,
  get: PlaneTransport,
  progress: Progress,
  opts: { projectIds?: string[] } = {},
): Promise<NonNullable<PlaneImportStatus["result"]>> {
  const result = { projects: 0, created: 0, updated: 0, features: 0, cycles: 0 };
  const all = await listAll<PlaneProject>(get, "/projects/");
  const chosen = all.filter((p) => !p.archived_at && (!opts.projectIds?.length || opts.projectIds.includes(p.id)));

  for (const p of chosen) {
    await progress.step(`${p.identifier}: project`);
    const { project, created } = await ensureLocalProject(db, p);
    if (created) await progress.step(`${p.identifier}: created project "${project.name}"`);
    const projectRef = `projects:${project.id}`;

    const [states, labels, modules, planeCycles] = await Promise.all([
      listAll<PlaneState>(get, `/projects/${p.id}/states/`),
      listAll<PlaneLabel>(get, `/projects/${p.id}/labels/`),
      listAll<PlaneModule>(get, `/projects/${p.id}/modules/`),
      listAll<PlaneCycle>(get, `/projects/${p.id}/cycles/`),
    ]);
    const stateById = new Map(states.map((s) => [s.id, s]));
    const labelById = new Map(labels.map((l) => [l.id, l.name]));

    // modules → features, and item → feature membership
    const featureOf = new Map<string, string>();
    for (const m of modules.filter((m) => !m.archived_at)) {
      const fid = await upsertFeature(db, project.id, m);
      result.features++;
      for (const i of await listAll<{ id: string }>(get, `/projects/${p.id}/modules/${m.id}/module-issues/`)) {
        if (!featureOf.has(i.id)) featureOf.set(i.id, `features:${fid}`);
      }
    }
    // cycles → cycles, and item → cycle membership
    const cycleOf = new Map<string, string>();
    for (const c of planeCycles.filter((c) => !c.archived_at)) {
      const cid = await upsertCycle(db, project.id, c);
      if (!cid) continue;
      result.cycles++;
      for (const i of await listAll<{ id: string }>(get, `/projects/${p.id}/cycles/${c.id}/cycle-issues/`)) {
        cycleOf.set(i.id, cid);
      }
    }

    await progress.step(`${p.identifier}: work items`);
    const items = (await listAll<PlaneWorkItem>(get, itemsPath(p.id))).filter((i) => !i.is_draft && !i.archived_at);
    const localOf = new Map<string, string>();
    for (const i of items) {
      const ref = `plane:${i.id}`;
      const status = mapState(i.state ? stateById.get(i.state) : undefined);
      const fields: WorkItemPatch = {
        title: i.name.trim() || "(untitled)",
        notes: htmlToText(i.description_html),
        status,
        priority: mapPriority(i.priority),
        startAt: planeDate(i.start_date),
        dueAt: planeDate(i.target_date),
        labels: labelNames(i, labelById),
        featureRef: featureOf.get(i.id) ?? null,
        cycleId: cycleOf.get(i.id) ?? null,
      };
      const [cur] = await db.select().from(tasks).where(eq(tasks.externalRef, ref));
      if (cur) {
        // Moved out of this project locally? Leave it where the user put it.
        const patch = cur.projectRef === projectRef ? fields : { ...fields, featureRef: undefined };
        await updateWorkItem(db, cur.id, { ...patch, completedAt: planeDate(i.completed_at) ?? undefined }, ACTOR);
        localOf.set(i.id, cur.id);
        result.updated++;
      } else {
        const created = await createWorkItem(
          db,
          {
            ...fields,
            title: fields.title!,
            projectRef,
            externalRef: ref,
            createdAt: planeDate(i.created_at) ?? undefined,
            completedAt: planeDate(i.completed_at),
            sortOrder: (planeDate(i.created_at)?.getTime() ?? Date.now()) / 1000,
          },
          ACTOR,
        );
        await addComment(db, created.id, `Imported from Plane (${p.identifier}-${i.sequence_id ?? "?"}).`, ACTOR);
        localOf.set(i.id, created.id);
        result.created++;
      }
    }

    // parents, once every item exists locally
    for (const i of items) {
      if (!i.parent) continue;
      const id = localOf.get(i.id);
      const parentId = localOf.get(i.parent);
      if (id && parentId) {
        await updateWorkItem(db, id, { parentId }, ACTOR).catch(() => {}); // a cycle in Plane data → skip
      }
    }
    // features re-derive from their (now complete) item sets
    const fids = await db
      .select({ id: features.id })
      .from(features)
      .where(and(eq(features.projectId, project.id), sql`${features.externalRef} like 'plane-module:%'`));
    for (const f of fids) await syncFeatureStatus(db, `features:${f.id}`);

    result.projects++;
    await progress.step(`${p.identifier}: ${items.length} items (${result.created} new so far)`);
  }
  return result;
}

/** Entry point for the worker job. payload: {"mode":"preview"} | {"mode":"import","projectIds":[…]} */
export async function runPlaneJob(db: Db, payload: string, get: PlaneTransport | null) {
  let input: { mode?: string; projectIds?: string[] } = {};
  try {
    input = JSON.parse(payload || "{}");
  } catch {
    input = {};
  }
  const mode = input.mode === "import" ? "import" : "preview";
  const progress = new Progress(mode);
  try {
    if (!get) throw new Error("Plane isn't connected — add the URL, workspace and API key in Settings → Connections");
    if (mode === "preview") {
      progress.status.plan = await previewPlane(db, get, progress);
    } else {
      progress.status.result = await importPlane(db, get, progress, { projectIds: input.projectIds });
    }
    progress.status.state = "done";
    await progress.step(mode === "preview" ? "preview ready" : "import finished");
  } catch (e) {
    progress.status.state = "failed";
    progress.status.error = e instanceof Error ? e.message : String(e);
    await progress.step(`failed: ${progress.status.error}`);
  } finally {
    progress.status.finishedAt = new Date().toISOString();
    await progress.save();
  }
}
