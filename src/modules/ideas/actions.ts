"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { recordUsage } from "@/core/usage";
import { ideas, type IdeaCategory, type IdeaStage } from "./schema";

function revalidate(id?: string) {
  revalidatePath("/");
  revalidatePath("/m/ideas");
  if (id) revalidatePath(`/m/ideas/${id}`);
}

export async function listIdeas() {
  return db.select().from(ideas).orderBy(desc(ideas.createdAt));
}

export async function createIdea(input: {
  title: string;
  category?: IdeaCategory;
  notes?: string;
}) {
  const title = input.title.trim();
  if (!title) return { ok: false as const, error: "An idea needs a title" };
  recordUsage("ideas.create");
  const [row] = await db
    .insert(ideas)
    .values({
      title,
      category: input.category ?? "product",
      notes: input.notes?.trim() || null,
    })
    .returning();
  revalidate();
  return row;
}

export async function setIdeaStage(id: string, stage: IdeaStage) {
  await db
    .update(ideas)
    .set({ stage, updatedAt: new Date() })
    .where(eq(ideas.id, id));
  revalidate(id);
}

export async function updateIdeaNotes(id: string, notes: string) {
  await db
    .update(ideas)
    .set({ notes: notes.trim() || null, updatedAt: new Date() })
    .where(eq(ideas.id, id));
  revalidate(id);
}

export async function deleteIdea(id: string) {
  await db.delete(ideas).where(eq(ideas.id, id));
  revalidate();
}

/** Link/unlink an idea to an existing project (entity-ref). */
export async function setIdeaProject(id: string, projectId: string | null) {
  await db
    .update(ideas)
    .set({
      projectRef: projectId ? `projects:${projectId}` : null,
      updatedAt: new Date(),
    })
    .where(eq(ideas.id, id));
  revalidate(id);
  revalidatePath("/m/projects");
  if (projectId) revalidatePath(`/m/projects/${projectId}`);
}

/** Queue the AI reality-check (runs in the worker). */
export async function requestAnalysis(id: string) {
  await db
    .update(ideas)
    .set({ analysisStatus: "analyzing", analysisError: null })
    .where(eq(ideas.id, id));
  await sql.notify("idea_analyze", id);
  revalidate(id);
}

/** Validated idea → real project (entity-ref linked, not duplicated). */
export async function promoteToProject(id: string): Promise<string> {
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, id));
  if (!idea) throw new Error("idea not found");
  if (idea.projectRef) return idea.projectRef.split(":")[1];

  const { createProject } = await import("@/modules/projects/actions");
  const project = await createProject({
    name: idea.title.slice(0, 120),
    description: idea.analysis?.summary ?? idea.notes ?? undefined,
  });
  await db
    .update(ideas)
    .set({
      projectRef: `projects:${project.id}`,
      stage: "validated",
      updatedAt: new Date(),
    })
    .where(eq(ideas.id, id));
  revalidate(id);
  revalidatePath("/m/projects");
  return project.id;
}
