import { isNull, isNotNull } from "drizzle-orm";
import { db } from "@/core/db/client";
import { knowledgeItems, type KnowledgeItem } from "./schema";

// Query/campaign params that don't change what a link points at.
const TRACKING =
  /^(utm_|itm_|mc_)|^(ref|ref_src|ref_url|fbclid|igshid|si|gclid|gclsrc|mc_cid|mc_eid|spm|source)$/i;

/** Canonical form of a URL for equality: drop the scheme, `www.`, a trailing
 *  slash, the fragment, and tracking params — so the same link pasted twice (or
 *  with an `?igshid=…`) is recognised as one. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (TRACKING.test(k)) u.searchParams.delete(k);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    const qs = u.searchParams.toString();
    return host + path + (qs ? `?${qs}` : "");
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Canonical form of free text for equality (whitespace + case). */
export function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

export type KnowledgeDuplicate = Pick<
  KnowledgeItem,
  "id" | "kind" | "title" | "input" | "status"
>;

/**
 * The existing knowledge item this input duplicates, or null. Links match by
 * normalized URL; quotes/snippets by normalized text. Personal knowledge bases
 * are small, so a scan of the candidate set (rows with / without a url) is fine.
 */
export async function findDuplicateKnowledge(candidate: {
  input: string;
  url: string | null;
}): Promise<KnowledgeDuplicate | null> {
  const cols = {
    id: knowledgeItems.id,
    kind: knowledgeItems.kind,
    title: knowledgeItems.title,
    input: knowledgeItems.input,
    status: knowledgeItems.status,
    url: knowledgeItems.url,
  };
  const pick = (r: KnowledgeDuplicate & { url: string | null }): KnowledgeDuplicate => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    input: r.input,
    status: r.status,
  });

  if (candidate.url) {
    const target = normalizeUrl(candidate.url);
    const rows = await db
      .select(cols)
      .from(knowledgeItems)
      .where(isNotNull(knowledgeItems.url));
    const hit = rows.find((r) => r.url && normalizeUrl(r.url) === target);
    return hit ? pick(hit) : null;
  }

  const target = normalizeText(candidate.input);
  if (!target) return null;
  const rows = await db
    .select(cols)
    .from(knowledgeItems)
    .where(isNull(knowledgeItems.url));
  const hit = rows.find((r) => normalizeText(r.input) === target);
  return hit ? pick(hit) : null;
}
