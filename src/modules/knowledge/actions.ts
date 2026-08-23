"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { detectKind } from "./detect";
import { findDuplicateKnowledge, type KnowledgeDuplicate } from "./dedup";
import { knowledgeItems, type KnowledgeItem } from "./schema";

export async function listKnowledge() {
  return db
    .select()
    .from(knowledgeItems)
    .orderBy(desc(knowledgeItems.createdAt));
}

export type CaptureResult =
  | { duplicate: true; item: KnowledgeDuplicate }
  | { duplicate: false; item: KnowledgeItem };

export async function captureKnowledge(
  input: string,
  note?: string,
): Promise<CaptureResult> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("nothing to capture");
  const { kind, url } = detectKind(trimmed);

  // Don't capture the same link/snippet twice — point back at the existing one.
  const existing = await findDuplicateKnowledge({ input: trimmed, url });
  if (existing) return { duplicate: true, item: existing };

  const [row] = await db
    .insert(knowledgeItems)
    .values({
      input: trimmed,
      kind,
      url,
      note: note?.trim() || null,
      // Quotes/plain text skip fetching; still enriched by the worker.
      status: "captured",
    })
    .returning();
  await sql.notify("knowledge_ingest", row.id);
  revalidatePath("/");
  revalidatePath("/m/knowledge");
  return { duplicate: false, item: row };
}

export async function retryKnowledge(id: string) {
  await db
    .update(knowledgeItems)
    .set({ status: "captured", statusDetail: null, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, id));
  await sql.notify("knowledge_ingest", id);
  revalidatePath("/m/knowledge");
}

export async function updateKnowledgeNote(id: string, note: string) {
  await db
    .update(knowledgeItems)
    .set({ note: note.trim() || null, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, id));
  revalidatePath(`/m/knowledge/${id}`);
}

export async function deleteKnowledge(id: string) {
  await db.delete(knowledgeItems).where(eq(knowledgeItems.id, id));
  revalidatePath("/");
  revalidatePath("/m/knowledge");
}
