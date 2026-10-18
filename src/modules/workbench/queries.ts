import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/core/db/client";
import { diffSince, type DiffSummary } from "./git";
import { executorAvailability } from "./adapters/capabilities";
import { TYPE_DEFAULT_EXECUTOR } from "./defaults";
import {
  attemptEvents,
  executors,
  routines,
  taskAttempts,
  workbenchTasks,
  type AttemptEvent,
  type TaskAttempt,
  type TaskType,
  type WorkbenchTask,
} from "./schema";

export type Routine = typeof routines.$inferSelect;

/** All routines, newest first — for the Workbench routines panel. */
export async function listRoutines(): Promise<Routine[]> {
  return db.select().from(routines).orderBy(desc(routines.createdAt));
}

export interface TaskWithAttempt extends WorkbenchTask {
  latest: TaskAttempt | null;
  attemptCount: number;
}

/** Cards for the board: every live task, newest first, with its latest run. */
export async function listTasks(archived = false): Promise<TaskWithAttempt[]> {
  const tasks = await db
    .select()
    .from(workbenchTasks)
    .where(
      archived
        ? isNotNull(workbenchTasks.archivedAt)
        : isNull(workbenchTasks.archivedAt),
    )
    .orderBy(desc(workbenchTasks.createdAt))
    .limit(60);
  if (tasks.length === 0) return [];

  const attempts = await db
    .select()
    .from(taskAttempts)
    .orderBy(asc(taskAttempts.seq));
  const byTask = new Map<string, TaskAttempt[]>();
  for (const a of attempts) {
    const list = byTask.get(a.taskId) ?? [];
    list.push(a);
    byTask.set(a.taskId, list);
  }

  return tasks.map((t) => {
    const list = byTask.get(t.id) ?? [];
    return {
      ...t,
      latest: list.length ? list[list.length - 1] : null,
      attemptCount: list.length,
    };
  });
}

export interface TaskDetail {
  task: WorkbenchTask;
  attempts: TaskAttempt[];
  events: AttemptEvent[];
  /** Of the selected attempt — absent for non-repo work. */
  diff: DiffSummary | null;
}

export async function getTaskDetail(
  taskId: string,
  attemptId?: string,
): Promise<TaskDetail | null> {
  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId));
  if (!task) return null;

  const attempts = await db
    .select()
    .from(taskAttempts)
    .where(eq(taskAttempts.taskId, taskId))
    .orderBy(asc(taskAttempts.seq));

  const selected =
    attempts.find((a) => a.id === attemptId) ?? attempts[attempts.length - 1];
  if (!selected) return { task, attempts, events: [], diff: null };

  const events = await db
    .select()
    .from(attemptEvents)
    .where(eq(attemptEvents.attemptId, selected.id))
    .orderBy(asc(attemptEvents.at))
    .limit(400);

  // The diff is read live from the worktree rather than stored: it stays true
  // even if you poke at the branch by hand between reviews.
  let diff: DiffSummary | null = null;
  if (selected.workdir && selected.baseSha) {
    diff = await diffSince(selected.workdir, selected.baseSha).catch(() => null);
  }

  return { task, attempts, events, diff };
}

/** Dashboard widget: what is in flight right now. */
export async function countActiveTasks() {
  const rows = await db
    .select({ status: workbenchTasks.status })
    .from(workbenchTasks)
    .where(isNull(workbenchTasks.archivedAt));
  return {
    running: rows.filter((r) => r.status === "running").length,
    queued: rows.filter((r) => r.status === "queued").length,
    review: rows.filter((r) => r.status === "review").length,
  };
}

export async function listRunningTasks() {
  return db
    .select()
    .from(workbenchTasks)
    .where(
      and(isNull(workbenchTasks.archivedAt), eq(workbenchTasks.status, "running")),
    )
    .limit(5);
}

/** Executors offered in the new-task override and edited in Settings. Each row
 *  carries whether it can actually run on THIS host (its CLI binary is present),
 *  so the picker can disable/annotate the ones that can't (e.g. in a container). */
export async function listExecutors() {
  const rows = await db
    .select({
      id: executors.id,
      name: executors.name,
      kind: executors.kind,
      defaultModel: executors.defaultModel,
      commandTemplate: executors.commandTemplate,
      gitMode: executors.gitMode,
      enabled: executors.enabled,
    })
    .from(executors)
    .orderBy(asc(executors.id));
  return rows.map((r) => {
    const a = executorAvailability(r.kind, { commandTemplate: r.commandTemplate });
    return { ...r, available: a.ok, unavailableReason: a.reason ?? null };
  });
}

/** Resolve the executor a new task should run on. Falls back to `native` (always
 *  available) when the chosen/default executor's CLI isn't installed here, so a
 *  container never queues a task doomed to fail on a missing binary — and says
 *  so: callers record the fallback on the attempt (noteExecutorFallback). */
export async function pickExecutor(
  explicitId: string | undefined,
  taskType: TaskType,
): Promise<{ executorId: string; fallback: { from: string; reason: string } | null }> {
  const id = explicitId || TYPE_DEFAULT_EXECUTOR[taskType];
  const [row] = await db
    .select({ kind: executors.kind, commandTemplate: executors.commandTemplate })
    .from(executors)
    .where(eq(executors.id, id));
  if (!row) return { executorId: id, fallback: null }; // unknown id — let the engine's gate report it
  const a = executorAvailability(row.kind, {
    commandTemplate: row.commandTemplate,
    taskType,
  });
  return a.ok
    ? { executorId: id, fallback: null }
    : { executorId: "native", fallback: { from: id, reason: a.reason ?? "unavailable" } };
}

/** Put a fallback on the attempt's timeline, so the run shows it didn't get the executor it asked for. */
export async function noteExecutorFallback(
  attemptId: string,
  fallback: { from: string; reason: string } | null,
): Promise<void> {
  if (!fallback) return;
  await db.insert(attemptEvents).values({
    attemptId,
    type: "status",
    payload: {
      phase: `executor fallback: ${fallback.from} → native (${fallback.reason})`,
      fallbackFrom: fallback.from,
      reason: fallback.reason,
    },
  });
}
