"use server";

import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { clipToObsidianRaw } from "@/core/obsidian-clip";
import { deleteBranchIfMerged, removeIsolation } from "./git";
import { pickExecutor } from "./queries";
import { assertFreeModel } from "./models";
import {
  attemptEvents,
  executors,
  taskAttempts,
  workbenchTasks,
  type TaskType,
} from "./schema";

function revalidate(id?: string) {
  revalidatePath("/");
  revalidatePath("/m/workbench");
  if (id) revalidatePath(`/m/workbench/${id}`);
}

/** First line of the prompt, trimmed — the card needs a name, you don't. */
function titleFrom(prompt: string) {
  const first = prompt.trim().split("\n")[0].trim();
  return first.length > 90 ? `${first.slice(0, 88)}…` : first;
}

/**
 * Edit the *initiate request* — the ask itself, not just what came back. The
 * title tracks the first line so the card stays recognizable. This only saves;
 * re-running is an explicit, separate action (the "Re-run" button) so a typo
 * mid-edit never spends a run.
 */
export async function updateTaskPrompt(taskId: string, prompt: string) {
  const next = prompt.trim();
  if (!next) throw new Error("the ask can't be empty");
  await db
    .update(workbenchTasks)
    .set({ prompt: next, title: titleFrom(next), updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await sql.notify("workbench_changed", taskId);
  revalidate(taskId);
}

/** File a task under any number of projects/areas (["projects:<uuid>", …]). */
export async function setTaskProjects(taskId: string, projectRefs: string[]) {
  const refs = [...new Set(projectRefs.filter(Boolean))];
  await db
    .update(workbenchTasks)
    .set({ projectRefs: refs, updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  revalidate(taskId);
}

/** Give a task its own header, independent of the auto-derived first line. */
export async function updateTaskTitle(taskId: string, title: string) {
  const next = title.trim().slice(0, 140);
  if (!next) throw new Error("the title can't be empty");
  await db
    .update(workbenchTasks)
    .set({ title: next, updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await sql.notify("workbench_changed", taskId);
  revalidate(taskId);
}

/** Edit the report text of an attempt (the "what came back" panel). */
export async function updateAttemptResult(
  attemptId: string,
  taskId: string,
  result: string,
) {
  await db
    .update(taskAttempts)
    .set({ result })
    .where(eq(taskAttempts.id, attemptId));
  revalidate(taskId);
}

/** Strip characters that can't live in a filename; keep it readable. */
/**
 * Write a Workbench report into the Obsidian vault's `raw/` folder (shared clip
 * helper — same format, rules and destination as Ask's save-to-Obsidian).
 */
export async function clipTaskToObsidian(input: {
  title: string;
  source: string;
  body: string;
  createdISODate: string; // "YYYY-MM-DD" (computed client-side; server has no Date)
}): Promise<{ path: string }> {
  return clipToObsidianRaw(input);
}

/**
 * Ask the worker to live-probe the free cloud models and prune the dead ones.
 * Fire-and-forget: the worker records results to the health ledger and NOTIFYs
 * when done, so the Settings picker refreshes with a cleaned list.
 */
export async function requestFreeModelVerify(force?: boolean) {
  await sql.notify("verify_free_models", force ? "force" : "");
}

export async function createTask(input: {
  prompt: string;
  taskType: TaskType;
  repoPath?: string | null;
  executorId?: string;
  model?: string | null;
  createdFrom?: string;
}) {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("a task needs a prompt");

  const [task] = await db
    .insert(workbenchTasks)
    .values({
      title: titleFrom(prompt),
      prompt,
      taskType: input.taskType,
      repoPath: input.repoPath?.trim() || null,
      createdFrom: input.createdFrom ?? null,
    })
    .returning();

  const [attempt] = await db
    .insert(taskAttempts)
    .values({
      taskId: task.id,
      seq: 1,
      executorId: await pickExecutor(input.executorId, input.taskType),
      model: input.model ?? null,
    })
    .returning();

  // The worker owns execution; the web app never spawns anything itself.
  await sql.notify("workbench_run", attempt.id);
  revalidate();
  return task;
}

/**
 * Retry as a sibling attempt, optionally on a different executor — the point
 * of separating task from attempt. History is kept, not overwritten.
 */
export async function retryTask(
  taskId: string,
  executorId?: string,
  model?: string | null,
) {
  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId));
  if (!task) throw new Error("task not found");

  const [last] = await db
    .select()
    .from(taskAttempts)
    .where(eq(taskAttempts.taskId, taskId))
    .orderBy(desc(taskAttempts.seq))
    .limit(1);

  const [attempt] = await db
    .insert(taskAttempts)
    .values({
      taskId,
      seq: (last?.seq ?? 0) + 1,
      executorId: await pickExecutor(
        executorId ?? last?.executorId ?? undefined,
        task.taskType,
      ),
      // An explicit model pins this attempt (e.g. a free-model comparison run);
      // otherwise inherit the previous attempt's model.
      model: model !== undefined ? model : (last?.model ?? null),
    })
    .returning();

  await db
    .update(workbenchTasks)
    .set({ status: "queued", updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await sql.notify("workbench_run", attempt.id);
  revalidate(taskId);
  return attempt;
}

export async function cancelTask(taskId: string) {
  const [live] = await db
    .select()
    .from(taskAttempts)
    .where(
      and(
        eq(taskAttempts.taskId, taskId),
        inArray(taskAttempts.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(taskAttempts.seq))
    .limit(1);
  if (live) await sql.notify("workbench_cancel", live.id);
  revalidate(taskId);
}

/**
 * Archive hides the card, reclaims the worktrees, and deletes any branch whose
 * work is already merged — so archived tasks stop leaving `aios/task-*` litter
 * in the repo. Unmerged branches survive untouched (the one copy of work you
 * haven't taken), exactly as hard-delete treats them.
 */
export async function archiveTask(taskId: string) {
  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId));
  if (!task) return;

  if (task.repoPath) {
    const attempts = await db
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, taskId));
    for (const a of attempts) {
      if (a.workdir) await removeIsolation(task.repoPath, a.workdir);
      if (a.branch) await deleteBranchIfMerged(task.repoPath, a.branch);
    }
  }

  await db
    .update(workbenchTasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await sql.notify("workbench_changed", taskId);
  revalidate(taskId);
}

/** Put an archived task back on the board. */
export async function unarchiveTask(taskId: string) {
  await db
    .update(workbenchTasks)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await sql.notify("workbench_changed", taskId);
  revalidate(taskId);
}

/**
 * Hard delete: the task, its attempts and their events, plus the worktrees.
 *
 * Branches are only deleted when they are already merged — an unmerged branch
 * is the one copy of work you haven't taken yet, so it survives and is named
 * in the return value. Nothing here can silently destroy an agent's output.
 */
export async function deleteTask(taskId: string): Promise<{
  deletedBranches: string[];
  keptBranches: string[];
}> {
  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId));
  if (!task) return { deletedBranches: [], keptBranches: [] };

  const attempts = await db
    .select()
    .from(taskAttempts)
    .where(eq(taskAttempts.taskId, taskId));

  // A running attempt must die before its worktree can be removed.
  const live = attempts.find(
    (a) => a.status === "running" || a.status === "queued",
  );
  if (live) {
    await sql.notify("workbench_cancel", live.id);
  }

  const deletedBranches: string[] = [];
  const keptBranches: string[] = [];
  if (task.repoPath) {
    for (const a of attempts) {
      if (a.workdir) await removeIsolation(task.repoPath, a.workdir);
      if (!a.branch) continue;
      if (await deleteBranchIfMerged(task.repoPath, a.branch)) {
        deletedBranches.push(a.branch);
      } else {
        keptBranches.push(a.branch);
      }
    }
  }

  // Events first, then attempts, then the task — these are entity-ref style
  // links, not FKs with cascade, so the order is ours to get right.
  const ids = attempts.map((a) => a.id);
  if (ids.length) {
    await db.delete(attemptEvents).where(inArray(attemptEvents.attemptId, ids));
    await db.delete(taskAttempts).where(eq(taskAttempts.taskId, taskId));
  }
  await db.delete(workbenchTasks).where(eq(workbenchTasks.id, taskId));

  await sql.notify("workbench_changed", taskId);
  revalidate();
  return { deletedBranches, keptBranches };
}

/** Edit an executor row — how a new coding agent joins apOS without code. */
export async function updateExecutor(
  id: string,
  patch: {
    defaultModel?: string | null;
    commandTemplate?: string | null;
    enabled?: string;
  },
) {
  // A local (cli) executor may only be pointed at a free model — reject a
  // metered one here so the user finds out at save time, not mid-run. Claude
  // executors are exempt (their model name legitimately looks metered).
  if (patch.defaultModel) {
    const [row] = await db
      .select({ kind: executors.kind })
      .from(executors)
      .where(eq(executors.id, id));
    if (row?.kind === "cli") assertFreeModel(patch.defaultModel);
  }

  await db
    .update(executors)
    .set({
      ...(patch.defaultModel !== undefined
        ? { defaultModel: patch.defaultModel || null }
        : {}),
      ...(patch.commandTemplate !== undefined
        ? { commandTemplate: patch.commandTemplate || null }
        : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    })
    .where(eq(executors.id, id));
  revalidatePath("/m/settings");
  revalidatePath("/m/workbench");
}

// ── Routines (A1) ──────────────────────────────────────────────────────────

export interface RoutineDraft {
  name: string;
  ask: string;
  triggerKind: "commit" | "schedule" | "both";
  schedule: string | null;
  note?: string;
}

/**
 * The routine BUILDER: turn a plain-English description into a routine draft
 * (title + trigger + a faithful ask). Runs the cheap `routine.builder` model
 * ONCE — it configures, it does NOT rewrite the user's intent. The caller
 * reviews the draft and picks the task executor before saving.
 */
export async function composeRoutine(description: string): Promise<
  { ok: true; draft: RoutineDraft } | { ok: false; error: string }
> {
  const desc = description.trim();
  if (desc.length < 10) return { ok: false, error: "describe it in a bit more detail" };

  const { resolveRoute } = await import("@/core/ai/routing");
  const route = await resolveRoute("routine.builder");

  const system =
    "You configure an apOS 'routine' — a standing instruction that re-runs automatically. " +
    "You do NOT do the work and you do NOT rewrite the user's instruction: preserve their wording and intent, only lifting it into a clean standing 'ask'. " +
    "Decide the trigger from their words: 'on each commit'/'when I push' → commit; 'daily'/'every morning'/a time → schedule (give a cron); both if they say both. " +
    "Respond with ONLY a JSON object: " +
    `{"name": string (a short 2-5 word title), "ask": string (their instruction, faithful), "triggerKind": "commit"|"schedule"|"both", "schedule": string|null (cron, only if scheduled), "note": string (one line on any assumption you made)}.`;

  let text = "";
  try {
    for await (const ev of route.provider.run({
      system,
      messages: [{ role: "user", content: `Compose a routine from this:\n\n${desc}` }],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
      track: { source: "workbench", label: "routine builder" },
    })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done" && ev.text) text = ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
    }
  } catch (e) {
    return { ok: false, error: `builder failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, error: "the builder didn't return a usable draft" };
  try {
    const o = JSON.parse(match[0]) as Partial<RoutineDraft>;
    const triggerKind =
      o.triggerKind === "schedule" || o.triggerKind === "both" ? o.triggerKind : "commit";
    return {
      ok: true,
      draft: {
        name: String(o.name ?? "Untitled routine").slice(0, 90),
        ask: String(o.ask ?? desc),
        triggerKind,
        schedule: triggerKind === "commit" ? null : (o.schedule ? String(o.schedule) : "0 8 * * 1-5"),
        note: o.note ? String(o.note).slice(0, 200) : undefined,
      },
    };
  } catch {
    return { ok: false, error: "the builder's draft wasn't valid JSON" };
  }
}

/** Create a recurring routine bound to a project's repo. */
export async function createRoutine(input: {
  name: string;
  projectId: string;
  prompt: string;
  executorId?: string;
  model?: string | null;
  triggerKind?: "commit" | "schedule" | "both" | "source";
  schedule?: string | null;
  sourceRef?: string | null;
  deliverPr?: boolean;
  gateEnabled?: boolean;
  gateModel?: string | null;
}) {
  const { routines } = await import("./schema");
  const { projects } = await import("@/modules/projects/schema");
  const { usableRepoPath } = await import("@/modules/projects/repo");

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId));
  if (!project) throw new Error("project not found");
  const repoPath = usableRepoPath(project.id, project.repoUrl);
  if (!repoPath) {
    throw new Error("that project has no code repo attached — add one first");
  }

  const [row] = await db
    .insert(routines)
    .values({
      name: input.name.trim() || "Untitled routine",
      projectId: input.projectId,
      repoPath,
      prompt: input.prompt.trim(),
      executorId: input.executorId ?? "opencode",
      model: input.model ?? null,
      triggerKind: input.triggerKind ?? "commit",
      schedule: input.schedule?.trim() || null,
      sourceRef: input.sourceRef?.trim() || null,
      deliverPr: input.deliverPr === false ? "false" : "true",
      gateEnabled: input.gateEnabled === false ? "false" : "true",
      gateModel: input.gateModel?.trim() || null,
    })
    .returning();
  await sql.notify("routines_changed", row.id);
  revalidate();
  return row;
}

/** Edit a routine's fields in place (the ask, brain, trigger, schedule, PR). */
export async function updateRoutine(
  id: string,
  patch: {
    name?: string;
    prompt?: string;
    executorId?: string;
    model?: string | null;
    triggerKind?: "commit" | "schedule" | "both" | "source";
    schedule?: string | null;
    sourceRef?: string | null;
    deliverPr?: boolean;
    gateEnabled?: boolean;
    gateModel?: string | null;
  },
) {
  const { routines } = await import("./schema");
  await db
    .update(routines)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() || "Untitled routine" } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.executorId !== undefined ? { executorId: patch.executorId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.triggerKind !== undefined ? { triggerKind: patch.triggerKind } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule?.trim() || null } : {}),
      ...(patch.sourceRef !== undefined ? { sourceRef: patch.sourceRef?.trim() || null } : {}),
      ...(patch.deliverPr !== undefined ? { deliverPr: patch.deliverPr ? "true" : "false" } : {}),
      ...(patch.gateEnabled !== undefined ? { gateEnabled: patch.gateEnabled ? "true" : "false" } : {}),
      ...(patch.gateModel !== undefined ? { gateModel: patch.gateModel?.trim() || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(routines.id, id));
  await sql.notify("routines_changed", id);
  revalidate();
}

export async function setRoutineEnabled(id: string, enabled: boolean) {
  const { routines } = await import("./schema");
  await db
    .update(routines)
    .set({ enabled: enabled ? "true" : "false", updatedAt: new Date() })
    .where(eq(routines.id, id));
  await sql.notify("routines_changed", id);
  revalidate();
}

export async function deleteRoutine(id: string) {
  const { routines } = await import("./schema");
  await db.delete(routines).where(eq(routines.id, id));
  await sql.notify("routines_changed", id);
  revalidate();
}

/** Fire a routine now (the worker owns the actual run). */
export async function runRoutineNow(id: string) {
  await sql.notify("routines_run", id);
  revalidate();
}

/**
 * Manually request a PR for any task's branch — queues the SAME approval-gated
 * openPR the routines use, so a hand-run delegation lands the same way: draft →
 * approve → push+open. Never a direct write.
 */
export async function requestPR(taskId: string) {
  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId));
  if (!task) throw new Error("task not found");
  if (!task.repoPath) throw new Error("task has no repo");

  const { approvals } = await import("@/core/db/schema/approvals");
  const title = `apOS: ${task.title}`.slice(0, 120);
  const body = [
    `Proposed by apOS from the Workbench task "${task.title}".`,
    task.summary ? `\n**What changed:** ${task.summary}` : "",
    "\n_Review before merge — apOS proposes, it never merges._",
  ].join("");
  const [row] = await db
    .insert(approvals)
    .values({
      agentId: task.id, // no agent run for a manual PR — the task stands in
      runId: task.id,
      agentName: "Workbench",
      toolName: "workbench.openPR",
      input: { taskId, title, body },
    })
    .returning();
  await sql.notify("approvals_changed", row.id);
  revalidate(taskId);
  return row;
}

/** "I've looked at the diff" — closes the card without touching the branch. */
export async function acceptTask(taskId: string) {
  await db
    .update(workbenchTasks)
    .set({ status: "done", updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await sql.notify("workbench_changed", taskId);
  revalidate(taskId);
}
