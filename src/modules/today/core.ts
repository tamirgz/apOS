/**
 * Worker-safe core for the attention spine — no `use server`, no `next/cache`.
 * The agent tools (worker) and the web server actions both call these; only
 * the web actions add `revalidatePath` on top. This is the pattern that keeps
 * `revalidatePath` from throwing when an agent raises a card from the worker.
 */
import { and, eq, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { isUniqueViolation } from "@/core/db/errors";
import { embedText, groundProjectRef } from "@/core/embeddings";
import { indexRow } from "@/core/search-index";
import { attentionItems, type AttentionType } from "./schema";

// Below this cosine distance, two attention titles are treated as the same
// real item. Calibrated against live data: reworded duplicates measured
// 0.16–0.23, genuinely-distinct tasks 0.49+, so 0.35 separates them with a
// wide margin (well under the codebase's 0.55 "related" gate).
const ATTENTION_DUP_DISTANCE = 0.35;

const toVec = (e: number[]) => `[${e.join(",")}]`;

/**
 * Canonicalize an entity ref to "<kind>:<uuid>". Agents pass the anchor
 * inconsistently — sometimes "projects:<uuid>", sometimes a bare "<uuid>" —
 * which both breaks the content dedupe key (same task, two keys) and leaves
 * the card unlinked in the UI. Normalizing fixes both.
 */
export function normalizeRef(
  ref: string | null | undefined,
  kind: "projects" | "people",
): string | null {
  if (!ref) return null;
  const bare = ref.startsWith(`${kind}:`) ? ref.slice(kind.length + 1) : ref;
  return `${kind}:${bare}`;
}

export interface RaiseInput {
  type: AttentionType;
  title: string;
  body?: string | null;
  projectRef?: string | null;
  personRef?: string | null;
  source?: string;
  urgency?: number;
  dueAt?: Date | null;
  href?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  /**
   * The projectRef is BACKBONE-BOUND (from a focused subject), not model-guessed
   * — so skip the text-grounding second-guess, which exists only to correct a
   * weak model's anchor and would otherwise strip a correct anchor whose title
   * doesn't lexically match the project.
   */
  trustProjectRef?: boolean;
}

/**
 * A stable dedupe key derived from the card's CONTENT — the same real thing
 * gets the same key no matter which agent raises it. This is deliberately
 * agent-agnostic: the duplicates we saw came from two different agents
 * (Daily planner, Loose-ends chaser) raising the identical item under their
 * own per-agent keys ("plan:…", "looseend:…"), which a per-key scheme can
 * never collapse. Keying on (project + person + normalized title) instead
 * means at most one OPEN card per real item, whoever raises it. Anchors are
 * included so the same phrasing about different projects/people stays
 * distinct. Callers' own `dedupeKey` is intentionally NOT used here — a
 * content key is the only thing that dedupes across agents.
 */
export function deriveDedupeKey(input: {
  projectRef?: string | null;
  personRef?: string | null;
  title: string;
}): string {
  const proj = input.projectRef ?? "-";
  const person = input.personRef ?? "-";
  const title = input.title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
  return `auto:${proj}:${person}:${title}`;
}

/**
 * Insert an attention item, idempotent on `dedupeKey`: at most one OPEN card
 * per key ever exists, so a re-running agent never stacks duplicate nudges.
 * The key is the caller's explicit `dedupeKey` or, failing that, one derived
 * from the card content. A partial unique index (attention_dedupe_open) is the
 * real guarantee — the pre-check just avoids the round-trip in the common
 * case, and a lost race surfaces as a unique violation we resolve by returning
 * the existing row. Returns the row (new or existing).
 */
export async function insertAttentionItem(input: RaiseInput) {
  const source = input.source ?? "system";
  // Ground the agent-supplied project anchor against the item's own text — a
  // weak model tends to stamp the week's dominant project on everything, so
  // drop/correct an anchor the content doesn't actually support before it's
  // persisted (and before it feeds the dedupe key).
  const normalizedProjectRef = normalizeRef(input.projectRef, "projects");
  const projectRef = input.trustProjectRef
    ? normalizedProjectRef
    : await groundProjectRef(normalizedProjectRef, input.title);
  const personRef = normalizeRef(input.personRef, "people");
  // Content key off the NORMALIZED refs — so "projects:<id>" and a bare "<id>"
  // from an inconsistent agent collapse to one key.
  const dedupeKey = deriveDedupeKey({ projectRef, personRef, title: input.title });

  const findOpenByKey = async () => {
    const [existing] = await db
      .select()
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.dedupeKey, dedupeKey),
          eq(attentionItems.status, "open"),
        ),
      )
      .limit(1);
    return existing;
  };

  // 1. Exact content match (cheap) — a re-run of the identical card.
  const exact = await findOpenByKey();
  if (exact) return exact;

  // 2. Semantic match — the same task reworded, or raised under a different
  // anchor by another agent, which the content key can't catch. Best-effort:
  // if embedding is unavailable (Ollama down), fall through to a plain insert
  // rather than blocking the raise.
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(input.title.trim());
    // Compare against sibling OPEN cards via the unified index. Joined back to
    // attention_items on status='open' so a card closed within the last sync
    // window can't resurface as a false duplicate.
    const [near] = await db.execute<{ id: string; distance: number }>(dsql`
      select a.id, (si.embedding <=> ${toVec(embedding)}::vector) as distance
      from search_index si
      join attention_items a on a.id::text = si.source_id and a.status = 'open'
      where si.kind = 'attention' and si.embedding is not null
      order by distance asc
      limit 1
    `);
    if (near && Number(near.distance) < ATTENTION_DUP_DISTANCE) {
      const [dup] = await db
        .select()
        .from(attentionItems)
        .where(eq(attentionItems.id, near.id))
        .limit(1);
      if (dup) return dup;
    }
  } catch {
    embedding = null; // degrade gracefully to content-hash-only dedup
  }

  try {
    const [row] = await db
      .insert(attentionItems)
      .values({
        type: input.type,
        title: input.title.trim(),
        body: input.body?.trim() || null,
        projectRef,
        personRef,
        source,
        urgency: input.urgency ?? 0,
        dueAt: input.dueAt ?? null,
        href: input.href ?? null,
        payload: input.payload ?? {},
        dedupeKey,
      })
      .returning();
    // Push this card into the unified index right now (with its freshly-computed
    // title vector) so the NEXT agent's raise-time dedup sees it immediately,
    // rather than waiting for the 2-min sync.
    await indexRow("attention", row.id, embedding);
    await sql.notify("attention_changed", "");
    return row;
  } catch (e) {
    // Lost the race against a concurrent raise of the same key — the winner's
    // OPEN row is what the caller wanted anyway.
    if (isUniqueViolation(e)) {
      const winner = await findOpenByKey();
      if (winner) return winner;
    }
    throw e;
  }
}

/** Re-open snoozed items whose time has come. Called by the worker sweep. */
export async function wakeSnoozed(): Promise<number> {
  const woken = await db
    .update(attentionItems)
    .set({ status: "open", snoozedUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(attentionItems.status, "snoozed"),
        dsql`${attentionItems.snoozedUntil} <= now()`,
      ),
    )
    .returning({ id: attentionItems.id });
  if (woken.length) await sql.notify("attention_changed", "");
  return woken.length;
}

/** Drop long-dead rows so the table can't grow without bound. */
export async function pruneAttention(): Promise<void> {
  await db
    .delete(attentionItems)
    .where(
      and(
        dsql`${attentionItems.status} in ('done','dismissed')`,
        dsql`${attentionItems.updatedAt} < now() - interval '30 days'`,
      ),
    );
}
