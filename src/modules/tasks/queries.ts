import { asc, eq, ne } from "drizzle-orm";
import { db } from "@/core/db/client";
import { features, projects, type FeatureStatus } from "@/modules/projects/schema";
import { listWorkItems, type WorkItem } from "./core";

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
  targetAt: Date | null;
  shippedAt: Date | null;
  sortOrder: number;
}

export interface WorkData {
  items: WorkItem[];
  projects: WorkProject[];
  features: WorkFeature[];
}

/** Everything a Work view needs: items (+identifiers), the project picker, features. */
export async function loadWorkData(projectId?: string): Promise<WorkData> {
  const [items, projectRows, featureRows] = await Promise.all([
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
        targetAt: features.targetAt,
        shippedAt: features.shippedAt,
        sortOrder: features.sortOrder,
      })
      .from(features)
      .where(projectId ? eq(features.projectId, projectId) : undefined)
      .orderBy(asc(features.sortOrder), asc(features.createdAt)),
  ]);
  return { items, projects: projectRows, features: featureRows };
}
