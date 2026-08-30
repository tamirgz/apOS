import { and, eq, inArray, lt, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { enrichItem } from "./enrich";
import { fetchRaw } from "./fetchers";
import { knowledgeItems, type KnowledgeStatus } from "./schema";

async function setStatus(
  id: string,
  status: KnowledgeStatus,
  patch: Record<string, unknown> = {},
) {
  await db
    .update(knowledgeItems)
    .set({ status, updatedAt: new Date(), ...patch })
    .where(eq(knowledgeItems.id, id));
  await sql.notify("knowledge_changed", id);
}

/**
 * Staged pipeline: captured → fetching → enriching → ready | error.
 * Runs in the worker (LISTEN "knowledge_ingest", payload = item id).
 * Each stage persists its output, so a retry resumes with what exists.
 */
export async function processKnowledgeItem(itemId: string): Promise<void> {
  const [item] = await db
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, itemId));
  if (!item) return;
  if (item.status === "ready") return; // idempotent re-delivery guard

  try {
    let raw = item.raw as Record<string, unknown> | null;
    if (!raw && item.url) {
      await setStatus(itemId, "fetching", { statusDetail: null });
      raw = await fetchRaw(item.kind, item.url);
      await setStatus(itemId, "fetching", { raw });
    }

    await setStatus(itemId, "enriching");
    const insight = await enrichItem({ ...item, raw });

    const title =
      (raw?.title as string | undefined) ??
      item.title ??
      insight.summary.slice(0, 80);

    await setStatus(itemId, "ready", {
      insight,
      title,
      statusDetail: null,
    });
  } catch (e) {
    await setStatus(itemId, "error", { statusDetail: String(e).slice(0, 500) });
    // An errored item never reaches the search index — surface it instead of
    // letting the capture silently vanish until the user opens Knowledge.
    try {
      const { insertAttentionItem } = await import("@/modules/today/core");
      await insertAttentionItem({
        type: "do",
        title: `Knowledge capture failed to enrich: “${(item.title ?? item.input ?? item.url ?? "").slice(0, 80)}”`,
        body: `${String(e).slice(0, 200)}. Retry it from the Knowledge page.`,
        source: "knowledge",
        urgency: 12,
        href: "/m/knowledge",
        dedupeKey: "knowledge:failed-enrichment",
      });
    } catch {
      // surfacing is best-effort
    }
  }
}

export const knowledgeJobs: ModuleJob[] = [
  {
    channel: "knowledge_ingest",
    handle: (payload) => processKnowledgeItem(payload),
  },
  {
    // Recovery: an item interrupted mid-pipeline (e.g. a worker restart during
    // enrichment) is left in a non-terminal state with no re-delivery. Re-queue
    // anything stuck for >10 min. Idempotent — the pipeline resumes from the
    // stage that already persisted (raw is kept), and `ready` items are skipped.
    channel: "knowledge_reconcile",
    schedule: "*/10 * * * *",
    handle: async () => {
      const stuck = await db
        .select({ id: knowledgeItems.id })
        .from(knowledgeItems)
        .where(
          and(
            inArray(knowledgeItems.status, ["captured", "fetching", "enriching"]),
            lt(knowledgeItems.updatedAt, dsql`now() - interval '10 minutes'`),
          ),
        );
      for (const s of stuck) await sql.notify("knowledge_ingest", s.id);
    },
  },
];
