"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import { tasks } from "@/modules/tasks/schema";
import {
  projects,
  statusRank,
  type ProjectStatus,
} from "./schema";

const CATEGORY_ORDER_KEY = "project_category_order";

function revalidateProjects(id?: string) {
  revalidatePath("/");
  revalidatePath("/m/projects");
  if (id) revalidatePath(`/m/projects/${id}`);
}

export async function listProjects() {
  return db
    .select()
    .from(projects)
    .orderBy(statusRank, desc(projects.updatedAt));
}

export async function createProject(input: {
  name: string;
  description?: string;
}) {
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required");
  const [row] = await db
    .insert(projects)
    .values({
      name,
      description: input.description?.trim() || null,
    })
    .returning();
  revalidateProjects();
  return row;
}

export async function updateProject(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    status: ProjectStatus;
  }>,
) {
  // The project's grounded vector re-embeds via the search-index content-hash
  // gate when name/description/goal/linked-work changes — nothing to clear here.
  const [row] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  revalidateProjects(id);
  return row;
}

export async function deleteProject(id: string) {
  const { deleteProjectFilesFor } = await import("./files-actions");
  await deleteProjectFilesFor(id); // app-level cascade — files have no DB FK
  await db.delete(projects).where(eq(projects.id, id));
  revalidateProjects(id);
}

/** Assign the project's free-form category (null clears it). */
export async function setProjectCategory(id: string, category: string | null) {
  await db
    .update(projects)
    .set({ category: category?.trim() || null, updatedAt: new Date() })
    .where(eq(projects.id, id));
  revalidateProjects(id);
}

/** Attach a code repo (GitHub URL or local path) and clone/refresh it now. */
export async function setProjectRepo(id: string, repoUrl: string | null) {
  const url = repoUrl?.trim() || null;
  await db
    .update(projects)
    .set({ repoUrl: url, updatedAt: new Date() })
    .where(eq(projects.id, id));
  if (url) await sql.notify("project_repos_sync", id); // worker clones/refreshes
  revalidateProjects(id);
}

/** Refresh the per-project Advisor reads now — runs the Project-advisor agent
 *  (auto-creating it from its template the first time). */
export async function runProjectAdvisor() {
  const { agents } = await import("@/core/db/schema/agents");
  const { createFromTemplate, requestRun } = await import(
    "@/modules/agents/actions"
  );
  let [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, "Project advisor"));
  if (!agent) {
    const created = await createFromTemplate("project-advisor");
    agent = { id: created.id };
  }
  await requestRun(agent.id);
  revalidateProjects();
  return { ok: true as const };
}

/** Turn an advisor recommendation into a task in this project. */
export async function advisorToTask(projectId: string, title: string) {
  const { createTask } = await import("@/modules/tasks/actions");
  await createTask({ title: title.trim().slice(0, 200), projectRef: `projects:${projectId}` });
  revalidateProjects(projectId);
  return { ok: true as const };
}

/** Turn an advisor recommendation into a feature in this project. */
export async function advisorToFeature(projectId: string, name: string) {
  const { createFeature } = await import("./features-actions");
  await createFeature(projectId, name.trim().slice(0, 120));
  revalidateProjects(projectId);
  return { ok: true as const };
}

/** Re-run the advisor for ONE project from a user-supplied angle (Haiku). */
export async function reconsiderProject(projectId: string, angle: string) {
  const steer = angle.trim();
  if (!steer) return { error: "no angle" as const };
  const [p] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!p) return { error: "project not found" as const };

  const { getToolsByNames } = await import("@/core/ai/tool-registry");
  const { resolveRoute } = await import("@/core/ai/routing");
  // Which brain reads a project is configurable — Settings → AI Routing
  // ("project.advisor"), not hardcoded here.
  const route = await resolveRoute("project.advisor");
  const tools = getToolsByNames([
    "projects.list",
    "tasks.list",
    "projects.readRepo",
    "projects.setAdvisorBrief",
  ]);
  for await (const ev of route.provider.run({
    system:
      "You are the user's chief-of-staff for their projects. Be sharp, specific and honest — no boilerplate, no restating the goal.",
    messages: [
      {
        role: "user",
        content:
          `Reconsider ONLY the project "${p.name}" (id ${projectId}) from this angle: "${steer}". ` +
          "Gather its context first (call tasks.list, and projects.readRepo if it has a code repo), then write ONE fresh read for THIS project via projects.setAdvisorBrief — state, blocker (or null), and recommendation — reflecting the requested angle. Call setAdvisorBrief exactly once, for this project only.",
      },
    ],
    tools,
    toolCtx: { db },
    model: "claude-haiku-4-5-20251001",
    maxTurns: 6,
    track: { source: "action", label: "advisor refresh" },
  })) {
    if (ev.type === "error") throw new Error(ev.message);
  }
  revalidateProjects(projectId);
  return { ok: true as const };
}

/** Persisted order of category groups on the Projects page (top → bottom). */
export async function setProjectCategoryOrder(names: string[]) {
  await setSetting(CATEGORY_ORDER_KEY, JSON.stringify(names));
  revalidateProjects();
}

export async function getProjectCategoryOrder(): Promise<string[]> {
  const raw = await getSetting(CATEGORY_ORDER_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Distinct categories already in use — feeds the cockpit's suggestion chips. */
export async function listProjectCategories(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: projects.category })
    .from(projects);
  return rows
    .map((r) => r.category)
    .filter((c): c is string => !!c)
    .sort((a, b) => a.localeCompare(b));
}

/** L2: the project's north-star outcome (one line). Null clears it. */
export async function setProjectGoal(id: string, goal: string | null) {
  await db
    .update(projects)
    .set({ goal: goal?.trim() || null })
    .where(eq(projects.id, id));
  revalidateProjects(id);
}

/** L2: the single next physical step. Shared with the Plan-my-day surface. */
export async function setProjectNextAction(id: string, nextAction: string | null) {
  await db
    .update(projects)
    .set({ nextAction: nextAction?.trim() || null, updatedAt: new Date() })
    .where(eq(projects.id, id));
  revalidateProjects(id);
}

/**
 * Complete the current next action: record it as a done task under the project
 * (a permanent trail + it counts toward "done"), then clear the field so the
 * project's health flips to "define the next step" and the planner proposes
 * the next one. Turns the next action from dead text into a moving cursor.
 */
export async function completeProjectNextAction(id: string) {
  const [proj] = await db
    .select({ nextAction: projects.nextAction })
    .from(projects)
    .where(eq(projects.id, id));
  const step = proj?.nextAction?.trim();
  if (!step) return;

  await db.insert(tasks).values({
    title: step,
    status: "done",
    completedAt: new Date(),
    projectRef: `projects:${id}`,
  });
  await db
    .update(projects)
    .set({ nextAction: null, updatedAt: new Date() })
    .where(eq(projects.id, id));
  revalidateProjects(id);
}
