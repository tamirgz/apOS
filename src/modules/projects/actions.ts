"use server";

import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import { attentionItems } from "@/modules/today/schema";
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

/**
 * Overrule the agent's health call: drop the stored judgement (the cockpit
 * falls back to the live signals) and dismiss the pulse card it raised.
 */
export async function clearProjectHealth(id: string) {
  await db
    .update(projects)
    .set({ health: null, healthReason: null, healthUpdatedAt: null, healthBy: null })
    .where(eq(projects.id, id));
  await db
    .update(attentionItems)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(attentionItems.projectRef, `projects:${id}`),
        eq(attentionItems.status, "open"),
        dsql`${attentionItems.dedupeKey} like 'pulse:%'`,
      ),
    );
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

/** Advisor prose is markdown-ish and can run long: its first line, stripped. */
const advisorLine = (text: string) =>
  text.trim().split("\n")[0].replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();

/** Turn an advisor next move (or blocker) into a work item in this project. */
export async function advisorToTask(projectId: string, text: string, kind: "next" | "blocker" = "next") {
  const { createTask } = await import("@/modules/tasks/actions");
  const { tasks, isClosed } = await import("@/modules/tasks/schema");
  const { withIdentifiers } = await import("@/modules/tasks/core");
  // The full text rides along in the notes.
  const full = text.trim();
  const title = `${kind === "blocker" ? "Unblock: " : ""}${advisorLine(full)}`.slice(0, 200);
  const projectRef = `projects:${projectId}`;
  // A second click on the same recommendation finds the item, not a duplicate.
  const open = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectRef, projectRef), dsql`lower(${tasks.title}) = ${title.toLowerCase()}`))
  ).filter((t) => !isClosed(t.status));
  if (open.length) {
    const [item] = await withIdentifiers(db, open.slice(0, 1));
    return { ok: true as const, identifier: item.identifier, existed: true };
  }
  const item = await createTask({
    title,
    notes: `${kind === "blocker" ? "Blocker" : "Next move"} flagged by the project advisor:\n\n${full}`,
    priority: kind === "blocker" ? "high" : "medium",
    labels: kind === "blocker" ? ["blocker"] : [],
    projectRef,
  });
  revalidateProjects(projectId);
  return { ok: true as const, identifier: item.identifier, existed: false };
}

/** Turn an advisor recommendation into a feature in this project. */
export async function advisorToFeature(projectId: string, name: string) {
  const { createFeature } = await import("./features-actions");
  await createFeature(projectId, advisorLine(name).slice(0, 120));
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
  const { runTask } = await import("@/core/ai/routing");
  // Which brain reads a project is configurable — Settings → AI Routing
  // ("project.advisor"); runTask falls back to a local model if it's exhausted.
  const tools = getToolsByNames([
    "projects.list",
    "tasks.list",
    "projects.readRepo",
    "projects.setAdvisorBrief",
  ]);
  for await (const ev of runTask("project.advisor", {
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
    maxTurns: 6,
    track: { source: "action", label: "advisor refresh" },
  })) {
    // Returned, not thrown: production redacts a thrown message.
    if (ev.type === "error") return { error: ev.message };
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

  const { createWorkItem } = await import("@/modules/tasks/core");
  await createWorkItem(db, { title: step, status: "done", projectRef: `projects:${id}` }, "user");
  await db
    .update(projects)
    .set({ nextAction: null, updatedAt: new Date() })
    .where(eq(projects.id, id));
  revalidateProjects(id);
}
