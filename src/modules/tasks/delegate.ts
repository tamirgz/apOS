/**
 * Hand a work item — or a whole feature — to the Workbench, and write the
 * run's outcome back onto the items.
 *
 *   delegate   → Workbench task (createdFrom "tasks:<id>" / "features:<id>"),
 *                a "workbench" link on each item, items move to In progress
 *   run settles → review: items → In review;  done: items → Done (a feature
 *                ships through the normal lifecycle); failed / needs input /
 *                cancelled: a comment, status left for the user
 *
 * The write-back listens on workbench_changed and is applied once per
 * transition (task_links.state remembers the last status written back).
 * Worker-safe: db passed in.
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { sql as notify, type Db } from "@/core/db/client";
import { features, projects } from "@/modules/projects/schema";
import { usableRepoPath } from "@/modules/projects/repo";
import { pickExecutor } from "@/modules/workbench/queries";
import { taskAttempts, workbenchTasks, type TaskType } from "@/modules/workbench/schema";
import { addComment, addLink, updateWorkItem, withIdentifiers, type Actor } from "./core";
import { isClosed, taskLinks, tasks, type Task } from "./schema";

const projectIdOf = (ref: string | null | undefined) =>
  ref?.startsWith("projects:") ? ref.slice("projects:".length) : null;

async function projectContext(db: Db, projectRef: string | null) {
  const pid = projectIdOf(projectRef);
  if (!pid) return { name: null as string | null, repoPath: null as string | null };
  const [p] = await db
    .select({ name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.id, pid));
  return { name: p?.name ?? null, repoPath: p ? usableRepoPath(pid, p.repoUrl) : null };
}

function itemBlock(t: Task & { identifier: string | null }) {
  return [
    `### ${t.identifier ?? "item"} — ${t.title}`,
    t.labels.length ? `Labels: ${t.labels.join(", ")}` : null,
    t.notes?.trim() || null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function startRun(
  db: Db,
  input: { title: string; prompt: string; taskType: TaskType; repoPath: string | null; createdFrom: string; projectRef: string | null },
) {
  const [wb] = await db
    .insert(workbenchTasks)
    .values({
      title: input.title.slice(0, 88),
      prompt: input.prompt,
      taskType: input.taskType,
      repoPath: input.repoPath,
      createdFrom: input.createdFrom,
      projectRefs: input.projectRef ? [input.projectRef] : [],
    })
    .returning();
  const [attempt] = await db
    .insert(taskAttempts)
    .values({ taskId: wb.id, seq: 1, executorId: await pickExecutor(undefined, input.taskType) })
    .returning();
  await notify.notify("workbench_run", attempt.id);
  return wb;
}

async function linkAndStart(db: Db, items: Task[], wb: { id: string; title: string }, actor: Actor) {
  for (const t of items) {
    await addLink(db, t.id, { kind: "workbench", ref: wb.id, title: wb.title, url: `/m/workbench/${wb.id}`, state: "queued" });
    if (t.status === "backlog" || t.status === "todo") await updateWorkItem(db, t.id, { status: "doing" }, actor);
    await addComment(db, t.id, `Delegated to the Workbench: ${wb.title}`, actor);
  }
}

/** One item (with its open sub-items as context) → one Workbench run. */
export async function delegateWorkItem(db: Db, id: string, actor: Actor, extra?: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) throw new Error("Work item not found");
  if (isClosed(row.status)) throw new Error("That item is already closed");
  const children = (await db.select().from(tasks).where(eq(tasks.parentId, id))).filter((c) => !isClosed(c.status));
  const [item, ...subs] = await withIdentifiers(db, [row, ...children]);
  const proj = await projectContext(db, row.projectRef);
  const taskType: TaskType = proj.repoPath ? "code" : "research";
  const prompt = [
    `Complete this work item${proj.name ? ` for the project "${proj.name}"` : ""}.`,
    "",
    itemBlock(item),
    subs.length ? `\nIts open sub-items (in scope):\n${subs.map(itemBlock).join("\n\n")}` : null,
    extra?.trim() ? `\nAdditional instructions:\n${extra.trim()}` : null,
    "",
    `When you commit, reference ${item.identifier ?? "the item"} in the commit message.`,
    APOS_TOOLS_HINT,
    "Finish with a short summary of what you did and anything left open.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const wb = await startRun(db, {
    title: `${item.identifier ?? ""} ${item.title}`.trim(),
    prompt,
    taskType,
    repoPath: proj.repoPath,
    createdFrom: `tasks:${id}`,
    projectRef: row.projectRef,
  });
  await linkAndStart(db, [row], wb, actor);
  return wb;
}

/** Only the Claude/Codex executors carry the apOS MCP server, hence "if". */
const APOS_TOOLS_HINT =
  "If you have the apOS work-tracker tools (apos: tasks__comment, tasks__create, …), use them to comment progress on the item and to file follow-up items you discover — but don't change the item's status: apOS moves it when this run finishes.";

/** A whole feature's open items → one Workbench run that ships the feature. */
export async function delegateFeature(db: Db, featureId: string, actor: Actor, extra?: string) {
  const [f] = await db.select().from(features).where(eq(features.id, featureId));
  if (!f) throw new Error("Feature not found");
  const open = (await db.select().from(tasks).where(eq(tasks.featureRef, `features:${featureId}`))).filter(
    (t) => !isClosed(t.status),
  );
  if (!open.length) throw new Error("This feature has no open items to delegate");
  const items = await withIdentifiers(db, open);
  const projectRef = `projects:${f.projectId}`;
  const proj = await projectContext(db, projectRef);
  const taskType: TaskType = proj.repoPath ? "code" : "research";
  const prompt = [
    `Deliver the feature "${f.name}"${proj.name ? ` for the project "${proj.name}"` : ""}.`,
    f.description?.trim() ? `\n${f.description.trim()}` : null,
    `\nIt is done when all of these work items are done:\n`,
    items.map(itemBlock).join("\n\n"),
    extra?.trim() ? `\nAdditional instructions:\n${extra.trim()}` : null,
    "",
    "Reference the identifiers (e.g. " + (items[0].identifier ?? "KEY-1") + ") in your commit messages.",
    APOS_TOOLS_HINT,
    "Finish with a short summary per item: done, or what is left.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const wb = await startRun(db, {
    title: `Feature: ${f.name}`,
    prompt,
    taskType,
    repoPath: proj.repoPath,
    createdFrom: `features:${featureId}`,
    projectRef,
  });
  await linkAndStart(db, open, wb, actor);
  return wb;
}

const TERMINAL = ["done", "cancelled"];

/** Write a Workbench task's current status back onto its linked items (once per transition). */
export async function syncFromWorkbench(db: Db, workbenchTaskId: string): Promise<number> {
  const [wb] = await db.select().from(workbenchTasks).where(eq(workbenchTasks.id, workbenchTaskId));
  if (!wb) return 0;
  const links = await db
    .select()
    .from(taskLinks)
    .where(and(eq(taskLinks.kind, "workbench"), eq(taskLinks.ref, workbenchTaskId)));
  let applied = 0;
  const actor = "system:workbench";
  const summary = wb.summary?.trim() ? `\n\n${wb.summary.trim().slice(0, 600)}` : "";
  for (const link of links) {
    if (link.state === wb.status) continue;
    // Claim the transition first so two listeners can't both apply it.
    const claimed = await db
      .update(taskLinks)
      .set({ state: wb.status })
      .where(and(eq(taskLinks.id, link.id), link.state ? eq(taskLinks.state, link.state) : undefined))
      .returning({ id: taskLinks.id });
    if (!claimed.length) continue;
    const [t] = await db.select().from(tasks).where(eq(tasks.id, link.taskId));
    if (!t) continue;
    switch (wb.status) {
      case "review":
        if (!isClosed(t.status)) await updateWorkItem(db, t.id, { status: "review" }, actor);
        await addComment(db, t.id, `Workbench finished — the result is waiting for your review.${summary}`, actor);
        break;
      case "done":
        if (!isClosed(t.status)) await updateWorkItem(db, t.id, { status: "done" }, actor);
        await addComment(db, t.id, `Workbench run accepted.${summary}`, actor);
        break;
      case "failed":
        await addComment(db, t.id, "Workbench run failed — open it to retry on another executor.", actor);
        break;
      case "needs_input":
        await addComment(db, t.id, "Workbench run needs your input — the judge rejected two attempts.", actor);
        break;
      case "cancelled":
        await addComment(db, t.id, "Workbench run was cancelled.", actor);
        break;
      default:
        continue; // queued / running — nothing to write back
    }
    applied++;
  }
  return applied;
}

/** Catch-up for NOTIFYs missed while the worker was down. */
export async function syncPendingWorkbenchLinks(db: Db): Promise<number> {
  const pending = await db
    .selectDistinct({ ref: taskLinks.ref })
    .from(taskLinks)
    .where(and(eq(taskLinks.kind, "workbench"), notInArray(taskLinks.state, TERMINAL)));
  let n = 0;
  for (const p of pending) n += await syncFromWorkbench(db, p.ref);
  return n;
}

/** Workbench runs linked to any of these items (for the feature row / drawer). */
export async function workbenchLinksFor(db: Db, taskIds: string[]) {
  if (!taskIds.length) return [];
  return db
    .select()
    .from(taskLinks)
    .where(and(eq(taskLinks.kind, "workbench"), inArray(taskLinks.taskId, taskIds)));
}
