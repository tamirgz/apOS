import { asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { features, projects, type FeatureStatus } from "@/modules/projects/schema";
import { blockedItemIds, listWorkItems, type WorkItem } from "./core";
import { listCycles, type CycleSummary } from "./cycles";
import { taskLinks, workViews, type WorkView } from "./schema";

export interface WorkProject {
  id: string;
  name: string;
  key: string | null;
  kind: "project" | "area";
}

export interface WorkFeature {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: FeatureStatus;
  startAt: Date | null;
  targetAt: Date | null;
  shippedAt: Date | null;
  sortOrder: number;
}

export interface WorkCommit {
  ref: string;
  title: string | null;
  url: string | null;
  at: Date;
}

export interface WorkData {
  items: WorkItem[];
  projects: WorkProject[];
  features: WorkFeature[];
  cycles: CycleSummary[];
  /** Open items with an open blocker. */
  blocked: string[];
  /** itemId → latest Workbench run status (queued/running/review/…) for delegated items. */
  delegated: Record<string, string>;
  /** Saved views for this surface (the project's, or all-work ones). */
  views: WorkView[];
  /** Open "blocks" relations (blocker → blocked, both still open): the blocked marker and timeline dependency lines. */
  deps: { from: string; to: string }[];
  /** itemId → its latest linked commit (from the repo watcher). */
  commits: Record<string, WorkCommit>;
  /** The newest linked commits, newest first — the "Repo" line of the cycle strip. */
  recentCommits: (WorkCommit & { taskId: string })[];
}

/** Everything a Work view needs: items (+identifiers), the project picker, features. */
export async function loadWorkData(projectId?: string): Promise<WorkData> {
  const [items, projectRows, featureRows, cycleRows, blocked, wbLinks, views, depRows, commitRows] = await Promise.all([
    // Descriptions are ~60% of the table's bytes and only the drawer shows one
    // (it loads its item fresh), so the list goes without.
    listWorkItems(db, { projectId, notes: false }),
    db
      .select({ id: projects.id, name: projects.name, key: projects.key, kind: projects.kind })
      .from(projects)
      .where(ne(projects.status, "archived"))
      .orderBy(asc(projects.name)),
    db
      .select({
        id: features.id,
        projectId: features.projectId,
        name: features.name,
        description: features.description,
        status: features.status,
        startAt: features.startAt,
        targetAt: features.targetAt,
        shippedAt: features.shippedAt,
        sortOrder: features.sortOrder,
      })
      .from(features)
      .where(projectId ? eq(features.projectId, projectId) : undefined)
      .orderBy(asc(features.sortOrder), asc(features.createdAt)),
    // A project page shows its own cycles and the cross-project ones.
    listCycles(db).then((all) => (projectId ? all.filter((c) => !c.projectId || c.projectId === projectId) : all)),
    blockedItemIds(db),
    db
      .select({ taskId: taskLinks.taskId, state: taskLinks.state, createdAt: taskLinks.createdAt })
      .from(taskLinks)
      .where(eq(taskLinks.kind, "workbench"))
      .orderBy(asc(taskLinks.createdAt)),
    db
      .select()
      .from(workViews)
      .where(projectId ? eq(workViews.projectId, projectId) : isNull(workViews.projectId))
      .orderBy(asc(workViews.sortOrder), asc(workViews.createdAt)),
    db.execute<{ from: string; to: string }>(sql`
      select r.from_id as "from", r.to_id as "to"
      from task_relations r
      join tasks b on b.id = r.from_id
      join tasks t on t.id = r.to_id
      where r.kind = 'blocks'
        and b.status not in ('done','cancelled')
        and t.status not in ('done','cancelled')`),
    db
      .select({ taskId: taskLinks.taskId, ref: taskLinks.ref, title: taskLinks.title, url: taskLinks.url, at: taskLinks.createdAt })
      .from(taskLinks)
      .where(eq(taskLinks.kind, "commit"))
      .orderBy(desc(taskLinks.createdAt))
      .limit(500),
  ]);
  const inScope = new Set(items.map((t) => t.id));
  const commits: Record<string, WorkCommit> = {};
  const recentCommits: WorkData["recentCommits"] = [];
  for (const c of commitRows) {
    if (!inScope.has(c.taskId)) continue;
    const row = { ref: c.ref, title: c.title, url: c.url, at: c.at };
    commits[c.taskId] ??= row; // newest first, so the first one wins
    if (recentCommits.length < 3) recentCommits.push({ ...row, taskId: c.taskId });
  }
  const delegated: Record<string, string> = {};
  for (const l of wbLinks) delegated[l.taskId] = l.state ?? "queued"; // later rows win
  return {
    items,
    projects: projectRows,
    features: featureRows,
    cycles: cycleRows,
    blocked: [...blocked],
    delegated,
    views,
    deps: [...depRows].map((r) => ({ from: r.from, to: r.to })),
    commits,
    recentCommits,
  };
}
