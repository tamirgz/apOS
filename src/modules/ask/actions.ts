"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/core/db/client";
import { recordUsage } from "@/core/usage";
import { clipToObsidianRaw } from "@/core/obsidian-clip";
import { answerQuestion, type AskAnswer } from "./answer";
import { askHistory, type AskHistoryEntry, type AskSource } from "./schema";

/** Ask a question, and persist it so revisiting it later is instant. */
export async function ask(query: string): Promise<AskAnswer & { historyId: string | null }> {
  recordUsage("ask.query");
  const result = await answerQuestion(query);
  const q = query.trim();
  if (!q) return { ...result, historyId: null };

  const [row] = await db
    .insert(askHistory)
    .values({
      query: q,
      answer: result.answer,
      sources: result.sources,
      model: result.model || null,
    })
    .returning({ id: askHistory.id });

  revalidatePath("/m/ask");
  return { ...result, historyId: row.id };
}

/** Full history, newest first — fetched once so re-opening a past question is instant, no re-query. */
export async function listAskHistory(): Promise<AskHistoryEntry[]> {
  return db.select().from(askHistory).orderBy(desc(askHistory.createdAt)).limit(200);
}

/** Delete one history entry. Deliberately no bulk/clear-all — one at a time. */
export async function deleteAskHistoryEntry(id: string): Promise<void> {
  await db.delete(askHistory).where(eq(askHistory.id, id));
  revalidatePath("/m/ask");
}

/** File an answer under any number of projects/areas (["projects:<uuid>", …]). */
export async function setAskProjects(id: string, projectRefs: string[]): Promise<void> {
  const refs = [...new Set(projectRefs.filter(Boolean))];
  await db.update(askHistory).set({ projectRefs: refs }).where(eq(askHistory.id, id));
  revalidatePath("/m/ask");
}

/** Give an answer its own header (or clear it back to the question with ""). */
export async function renameAskEntry(id: string, title: string): Promise<void> {
  const next = title.trim().slice(0, 140);
  await db
    .update(askHistory)
    .set({ title: next || null })
    .where(eq(askHistory.id, id));
  revalidatePath("/m/ask");
}

/**
 * Save an Ask answer into the Obsidian vault's `raw/` folder — same format,
 * rules and destination as Workbench outcomes. The note carries the answer, a
 * resolvable Sources list (so the inline [n] citations still make sense), and a
 * provenance credit line; the vault's raw→wiki automation takes it from there.
 */
export async function clipAnswerToObsidian(input: {
  title: string;
  answer: string;
  sources: AskSource[];
  model: string | null;
  createdISODate: string; // "YYYY-MM-DD" (server has no Date)
}): Promise<{ path: string }> {
  const sourcesMd = input.sources.length
    ? "\n\n## Sources\n" +
      input.sources.map((s) => `${s.n}. [${s.title}](${s.href})`).join("\n")
    : "";
  const credit = `Generated with ${input.model?.trim() || "apOS"} — via apOS Ask.`;
  const body = `${input.answer.trim()}${sourcesMd}\n\n---\n\n*${credit}*`;
  return clipToObsidianRaw({
    title: input.title,
    source: "", // Ask answers synthesise the user's own corpus — no single URL
    body,
    createdISODate: input.createdISODate,
  });
}
