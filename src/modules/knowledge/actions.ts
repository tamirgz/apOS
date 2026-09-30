"use server";

import { desc, eq, getTableColumns } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { recordUsage } from "@/core/usage";
import { detectKind } from "./detect";
import { findDuplicateKnowledge, type KnowledgeDuplicate } from "./dedup";
import { knowledgeItems, type KnowledgeItem } from "./schema";

export async function listKnowledge() {
  // `raw` is the fetched source (a README, a page's text) — the bulk of the
  // board's payload, and only the item's own page shows it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped from the select on purpose
  const { raw: _raw, ...cols } = getTableColumns(knowledgeItems);
  const rows = await db.select(cols).from(knowledgeItems).orderBy(desc(knowledgeItems.createdAt));
  return rows.map((r) => ({ ...r, raw: null }));
}

export type CaptureResult =
  | { duplicate: true; item: KnowledgeDuplicate }
  | { duplicate: false; item: KnowledgeItem };

export async function captureKnowledge(
  input: string,
  note?: string,
): Promise<CaptureResult> {
  recordUsage("knowledge.capture");
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
  // Purge the unified search-index entry in the same breath — it's what powers
  // semantic search, Orbit nodes and the cross-type "connections", all derived
  // from these embeddings. Without this the item lingers as a ghost (still
  // searchable / still an Orbit node / still a related-to edge) until the 2-min
  // orphan sweep catches up. Delete it now so removal is instant + atomic.
  await sql`delete from search_index where kind = 'knowledge' and source_id = ${id}`;
  revalidatePath("/");
  revalidatePath("/m/knowledge");
}
