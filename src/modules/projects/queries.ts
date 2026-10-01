// Plain server-side read queries (not server actions — no "use server").
// Cross-module reads (tasks / notes / attention) are allowed here: everything
// links to a project via the text entity ref "projects:<uuid>", not a FK.
import { asc, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/core/db/client";
import { notes } from "../notes/schema";
import { attentionItems } from "../today/schema";
import { priorityRank, tasks } from "../tasks/schema";
import { plainTitle } from "../tasks/states";
import { resolveHealth, type HealthSignals } from "./health";
import {
  projects,
  statusRank,
  type Project,
  type ProjectHealth,
} from "./schema";

export interface ProjectWithTaskCounts extends Project {
  taskCounts: { total: number; done: number };
}

/** First sentence of a longer brief — keeps a derived advisor next-action
 *  to one concrete line instead of the advisor's full 2-3 sentence paragraph. */
function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

/**
 * The L2 cockpit row: a project plus everything derived from its `projectRef`
 * links — task rollup, overdue count, linked notes, open attention cards, the
 * last time anything happened, and the resolved health (agent's if fresh, else
 * the read-time heuristic so it's never blank).
 */
export interface ProjectCockpit extends Project {
  taskCounts: { total: number; done: number; open: number; overdue: number };
  noteCount: number;
  openAttention: number;
  lastActivityAt: Date | null;
  resolvedHealth: { health: ProjectHealth; reason: string; source: "agent" | "derived" };
  /** Where `nextAction` came from: typed by you, the top open work item, or the
   *  advisor's suggestion (shown with a small tag instead of a text prefix). */
  nextActionSource: "user" | "task" | "advisor" | null;
}

/**
 * One query, all rollups as correlated subqueries so a project with no links
 * still returns a row. `lastActivityAt` is the newest signal across the project
 * itself and its tasks/notes/attention — always accurate, never stored.
 */
export async function getProjectCockpit(
  db: Db = defaultDb,
): Promise<ProjectCockpit[]> {
  const ref = sql`'projects:' || ${projects.id}`;
  const rows = await db
    .select({
      project: projects,
      total: sql<number>`(select count(*) from ${tasks} where ${tasks.projectRef} = ${ref})`,
      done: sql<number>`(select count(*) from ${tasks} where ${tasks.projectRef} = ${ref} and ${tasks.status} in ('done','cancelled'))`,
      overdue: sql<number>`(select count(*) from ${tasks} where ${tasks.projectRef} = ${ref} and ${tasks.status} not in ('done','cancelled') and ${tasks.dueAt} is not null and ${tasks.dueAt} < now())`,
      noteCount: sql<number>`(select count(*) from ${notes} where ${notes.projectRefs} @> jsonb_build_array(${ref}))`,
      openAttention: sql<number>`(select count(*) from ${attentionItems} where ${attentionItems.projectRef} = ${ref} and ${attentionItems.status} = 'open')`,
      lastActivityAt: sql<string | null>`greatest(
        ${projects.updatedAt},
        (select max(greatest(${tasks.createdAt}, coalesce(${tasks.completedAt}, ${tasks.createdAt}))) from ${tasks} where ${tasks.projectRef} = ${ref}),
        (select max(${notes.updatedAt}) from ${notes} where ${notes.projectRefs} @> jsonb_build_array(${ref})),
        (select max(${attentionItems.createdAt}) from ${attentionItems} where ${attentionItems.projectRef} = ${ref})
      )`,
      // The next action is DERIVED from real data — the soonest-due, then
      // highest-priority, then oldest OPEN task — never guessed. A stored
      // next_action (a user override, or the agent's "[Advise] …" written when a
      // project has no open tasks left) wins over it, below.
      nextTaskTitle: sql<string | null>`(
        select ${tasks.title} from ${tasks}
        where ${tasks.projectRef} = ${ref} and ${tasks.status} not in ('done','cancelled')
        order by (${tasks.dueAt} is null), ${tasks.dueAt} asc, ${priorityRank}, ${tasks.createdAt} asc
        limit 1
      )`,
    })
    .from(projects)
    .orderBy(statusRank, desc(projects.updatedAt));

  return rows.map(({ project, total, done, overdue, noteCount, openAttention, lastActivityAt, nextTaskTitle }) => {
    const open = Number(total) - Number(done);
    const last = lastActivityAt ? new Date(lastActivityAt) : null;
    // next_action, fully derived so it can never be guessed or cross-wired:
    //   1. a stored value (a user override) wins;
    //   2. else the soonest-due / highest-priority OPEN task;
    //   3. else (no open tasks) the advisor's recommendation (tagged via
    //      nextActionSource) — a path-forward suggestion grounded in the project's
    //      state (incl. its completed tasks). Reliable because the advisor
    //      covers every project, unlike a flaky per-run write.
    const advise = project.advisorNext ? firstSentence(project.advisorNext) : null;
    const nextAction =
      project.nextAction ?? (nextTaskTitle ? plainTitle(String(nextTaskTitle)) : advise);
    const nextActionSource = project.nextAction
      ? ("user" as const)
      : nextTaskTitle
        ? ("task" as const)
        : advise
          ? ("advisor" as const)
          : null;
    const signals: HealthSignals = {
      status: project.status,
      goal: project.goal,
      nextAction,
      lastActivityAt: last,
      overdue: Number(overdue),
      openTasks: open,
    };
    return {
      ...project,
      nextAction,
      nextActionSource,
      taskCounts: {
        total: Number(total),
        done: Number(done),
        open,
        overdue: Number(overdue),
      },
      noteCount: Number(noteCount),
      openAttention: Number(openAttention),
      lastActivityAt: last,
      resolvedHealth: resolveHealth(
        project.health,
        project.healthReason,
        project.healthUpdatedAt,
        signals,
        project.healthBy,
      ),
    };
  });
}

export async function getProjectsWithTaskCounts(
  db: Db = defaultDb,
): Promise<ProjectWithTaskCounts[]> {
  const ref = sql`'projects:' || ${projects.id}`;
  const rows = await db
    .select({
      project: projects,
      total: sql<number>`(select count(*) from ${tasks} where ${tasks.projectRef} = ${ref})`,
      done: sql<number>`(select count(*) from ${tasks} where ${tasks.projectRef} = ${ref} and ${tasks.status} in ('done','cancelled'))`,
    })
    .from(projects)
    .orderBy(statusRank, desc(projects.updatedAt));

  return rows.map(({ project, total, done }) => ({
    ...project,
    taskCounts: { total: Number(total), done: Number(done) },
  }));
}

/** Single-project cockpit row (detail page). */
export async function getProjectCockpitById(
  id: string,
  db: Db = defaultDb,
): Promise<ProjectCockpit | null> {
  const all = await getProjectCockpit(db);
  return all.find((p) => p.id === id) ?? null;
}

export async function getProjectTasks(projectId: string, db: Db = defaultDb) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.projectRef, `projects:${projectId}`))
    .orderBy(priorityRank, asc(tasks.createdAt));
}

export async function getProject(id: string, db: Db = defaultDb) {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return row ?? null;
}

export interface ProjectOption {
  id: string;
  name: string;
  kind: "project" | "area";
}

/**
 * Minimal list for an "attach to project" picker — every non-archived project
 * and area of development, so any item (an Ask answer, a Workbench task) can be
 * filed under one. The caller groups by `kind`.
 */
export async function listProjectOptions(db: Db = defaultDb): Promise<ProjectOption[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, kind: projects.kind })
    .from(projects)
    .where(sql`${projects.status} <> 'archived'`)
    .orderBy(asc(projects.kind), asc(projects.name));
  return rows as ProjectOption[];
}
