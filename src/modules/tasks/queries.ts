import { asc, eq, ne } from "drizzle-orm";
import { db } from "@/core/db/client";
import { features, projects, type FeatureStatus } from "@/modules/projects/schema";
import { blockedItemIds, listWorkItems, type WorkItem } from "./core";
import { listCycles, type CycleSummary } from "./cycles";
import { taskLinks } from "./schema";

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

export interface WorkData {
  items: WorkItem[];
  projects: WorkProject[];
  features: WorkFeature[];
  cycles: CycleSummary[];
  /** Open items with an open blocker. */
  blocked: string[];
  /** itemId → latest Workbench run status (queued/running/review/…) for delegated items. */
  delegated: Record<string, string>;
}

/** Everything a Work view needs: items (+identifiers), the project picker, features. */
export async function loadWorkData(projectId?: string): Promise<WorkData> {
  const [items, projectRows, featureRows, cycleRows, blocked, wbLinks] = await Promise.all([
    listWorkItems(db, { projectId }),
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
  ]);
  const delegated: Record<string, string> = {};
  for (const l of wbLinks) delegated[l.taskId] = l.state ?? "queued"; // later rows win
  return {
    items,
    projects: projectRows,
    features: featureRows,
    cycles: cycleRows,
    blocked: [...blocked],
    delegated,
  };
}
