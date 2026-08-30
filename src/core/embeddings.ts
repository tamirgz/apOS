import { isNull, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { searchIndex } from "@/core/db/schema/search-index";
import { withLocalSlot } from "@/core/ai/local-queue";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDING_MODEL_KEY = "embedding_model";
const ACTIVE_MODEL_KEY = "embedding_model_active";

// Small memo so per-row sweep calls don't hit app_settings each time.
let modelCache: { value: string; at: number } | null = null;

export async function getEmbeddingModel(): Promise<string> {
  if (modelCache && Date.now() - modelCache.at < 60_000) {
    return modelCache.value;
  }
  const { getSetting } = await import("@/core/app-settings");
  const value =
    (await getSetting(EMBEDDING_MODEL_KEY))?.trim() || DEFAULT_EMBEDDING_MODEL;
  modelCache = { value, at: Date.now() };
  return value;
}

export async function embedText(text: string): Promise<number[]> {
  const model = await getEmbeddingModel();
  // Serialized through the local-inference queue so the embed sweep doesn't
  // contend with (and get evicted by) a big chat model on the same machine.
  return withLocalSlot(async () => {
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`ollama embeddings (${model}) → ${res.status}`);
    }
    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding?.length) {
      throw new Error(`model "${model}" returned no embedding — is it an embedding model?`);
    }
    return data.embedding;
  });
}

/**
 * Different models live in incompatible vector spaces (and differ in
 * dimensions), so a model switch invalidates every stored embedding. Wipe
 * them all; the sweep rebuilds with the new model.
 */
async function handleModelSwitch(log: (m: string) => void): Promise<void> {
  const { getSetting, setSetting } = await import("@/core/app-settings");
  const configured = await getEmbeddingModel();
  const active = (await getSetting(ACTIVE_MODEL_KEY)) ?? DEFAULT_EMBEDDING_MODEL;
  if (configured === active) return;
  log(`embedding model changed ${active} → ${configured}: re-embedding everything`);
  // One vector space now — nulling the unified index re-embeds the whole corpus.
  await db.update(searchIndex).set({ embedding: null });
  await setSetting(ACTIVE_MODEL_KEY, configured);
}

const toVec = (e: number[]) => `[${e.join(",")}]`;

/**
 * Background sweep (worker, every 2 min): embed any row that doesn't have an
 * embedding yet. Idempotent by construction — only touches NULL embeddings.
 * Local model via Ollama: free, offline, no tokens.
 */
// Per-row failure backoff: a single row whose text makes the embedding model
// choke must not stall the whole corpus (the old loop aborted on the first
// throw and retried the same unordered batch forever). Rows back off
// exponentially (10 min → 24 h) and everything else keeps embedding.
const embedFailures = new Map<string, { fails: number; until: number }>();
const BACKOFF_BASE_MS = 10 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export async function sweepEmbeddings(
  log: (m: string) => void = () => {},
): Promise<number> {
  await handleModelSwitch(log);
  let done = 0;

  // One corpus, one loop. Every source now lives in `search_index`; the batch
  // is generous because a first full sync (or a model switch) has the whole
  // corpus to embed, and each row is a single local Ollama call — free, offline.
  // Embed the RICH `embed_text` (full body/excerpt/linked-work) when present,
  // else the short title+snippet (external sources that never set embed_text).
  // Freshest content first — updated_at only moves on real content changes.
  const idxRows = await db
    .select({
      id: searchIndex.id,
      title: searchIndex.title,
      snippet: searchIndex.snippet,
      embedText: searchIndex.embedText,
    })
    .from(searchIndex)
    .where(isNull(searchIndex.embedding))
    .orderBy(dsql`${searchIndex.updatedAt} desc`)
    .limit(80);
  const now = Date.now();
  let consecutiveFails = 0;
  for (const r of idxRows) {
    const backoff = embedFailures.get(r.id);
    if (backoff && backoff.until > now) continue;
    try {
      const e = await embedText(r.embedText ?? `${r.title}\n${r.snippet ?? ""}`);
      await db
        .update(searchIndex)
        .set({ embedding: dsql`${toVec(e)}::vector` })
        .where(dsql`${searchIndex.id} = ${r.id}`);
      embedFailures.delete(r.id);
      done++;
      consecutiveFails = 0;
    } catch (e) {
      const fails = (backoff?.fails ?? 0) + 1;
      embedFailures.set(r.id, {
        fails,
        until: now + Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_MAX_MS),
      });
      log(`embed failed (attempt ${fails}) for row ${r.id}: ${String(e).slice(0, 120)}`);
      // 3 failures in a row = the model server itself is down, not a bad row —
      // stop hammering it and let the next tick retry.
      if (++consecutiveFails >= 3) throw e;
    }
  }

  // Tell open pages that search/connections just got fresher data, so a note
  // you just typed shows its connections without a manual reload.
  if (done > 0) await sql.notify("embeddings_updated", String(done));
  return done;
}

export interface SemanticHit {
  kind:
    | "note"
    | "knowledge"
    | "task"
    | "vault"
    | "idea"
    | "notion"
    | "file"
    | "project"
    | "attention"
    | "memory"
    | "mail"
    | "event"
    | "telegram"
    | "report"
    | "person"
    | "inbox"
    | "workbench"
    | "ask"
    | "feature";
  id: string;
  title: string;
  snippet: string | null;
  href: string;
  distance: number;
  /** The area-of-development drawer this item was classified into (index rows). */
  area: string | null;
}

/** Fallback link for kinds whose UNION branch didn't select an explicit href. */
function hitHref(kind: string, id: string): string {
  switch (kind) {
    case "note":
      return `/m/notes/${id}`;
    case "knowledge":
      return `/m/knowledge/${id}`;
    case "idea":
      return `/m/ideas/${id}`;
    // vault rows carry the file path in `id` — deep-link into Obsidian.
    case "vault":
      return `obsidian://open?path=${encodeURIComponent(id)}`;
    case "notion":
      return "/m/notion";
    // Opens/downloads the actual attached file.
    case "file":
      return `/api/projects/files/${id}`;
    case "memory":
      return "/m/settings/memory";
    case "task":
      return "/m/tasks";
    default:
      // External kinds (mail/event/telegram/…) always carry an explicit href in
      // the index; an unknown new kind lands on the dashboard, not on Tasks.
      return "/";
  }
}

/**
 * Semantic search across the WHOLE corpus: the per-table embedded sources plus
 * the unified `search_index` (Gmail, Calendar, Telegram, reports, People, Inbox,
 * Workbench results, Ask answers) plus projects/attention/memory that used to be
 * embedded-but-unsearchable. One query, one local vector space.
 */
export async function searchEverything(
  query: string,
  limit = 8,
  opts?: { area?: string | null },
): Promise<SemanticHit[]> {
  const vec = toVec(await embedText(query));
  // "Open the relevant drawer": when the query's area is known, discount
  // same-area index items so they rank ahead of equally-similar off-topic ones.
  const boost = opts?.area
    ? dsql`* (case when area_ref = ${opts.area} then 0.82 else 1 end)`
    : dsql``;
  const rows = await db.execute<{
    kind: string;
    id: string;
    title: string;
    snippet: string | null;
    href: string | null;
    area: string | null;
    distance: number;
  }>(dsql`
    select kind, source_id as id, title, snippet, href, area_ref as area,
           (embedding <=> ${vec}::vector) ${boost} as distance
      from search_index where embedding is not null
     order by distance asc
     limit ${limit}
  `);
  return [...rows].map((r) => ({
    kind: r.kind as SemanticHit["kind"],
    id: r.id,
    title: r.title,
    snippet: r.snippet,
    href: r.href ?? hitHref(r.kind, r.id),
    area: r.area ?? null,
    distance: Number(r.distance),
  }));
}

// ── Relations layer ─────────────────────────────────────────────────────────
// (Superseded the old flat relatedTo() — getConnections below is the single
//  cross-type relations engine used by every detail page.)
// Quality gates. Cosine distance: 0 = identical, 1 = orthogonal. In a personal
// corpus, < ~0.55 is a genuine thematic match; looser than that is noise.
export const RELATED_MAX_DISTANCE = 0.55;
const PROJECT_STRONG = 0.45;
const PROJECT_POSSIBLE = 0.58;

export interface Connection {
  kind: "note" | "idea" | "knowledge" | "task" | "vault" | "project";
  id: string;
  title: string;
  snippet: string | null;
  href: string;
  distance: number;
}

export interface ProjectSuggestion {
  id: string;
  name: string;
  confidence: "strong" | "possible";
  distance: number;
}

export interface Connections {
  projectSuggestion: ProjectSuggestion | null;
  related: Connection[];
}

/**
 * Best-fit project via two signals, strongest first — now all over the unified
 * `search_index` (one vector space):
 *  1) Neighbour vote — which project do this item's closest notes/tasks already
 *     belong to (weighted by closeness). `project_refs` is a jsonb array, so we
 *     unnest it — an item filed under two projects votes for both.
 *  2) Direct — the project row (kind='project') whose grounded vector is closest.
 */
async function suggestProject(
  kind: string,
  sourceId: string,
): Promise<ProjectSuggestion | null> {
  // 1 — neighbour vote.
  const voteRows = await db.execute<{
    project_ref: string;
    score: number;
    best: number;
    n: number;
  }>(dsql`
    with target as (
      select embedding from search_index
       where kind = ${kind} and source_id = ${sourceId} and embedding is not null),
    neighbours as (
      select ref as project_ref,
             (si.embedding <=> (select embedding from target)) as d
        from search_index si, jsonb_array_elements_text(si.project_refs) ref
       where si.kind in ('note','task') and si.embedding is not null
         and ref like 'projects:%'
         and not (si.kind = ${kind} and si.source_id = ${sourceId})
         and (select embedding from target) is not null
         and (si.embedding <=> (select embedding from target)) < ${RELATED_MAX_DISTANCE})
    select project_ref,
           sum(${RELATED_MAX_DISTANCE} - d)::float8 as score,
           min(d)::float8 as best,
           count(*)::int as n
      from neighbours
     group by project_ref
     order by score desc
     limit 1
  `);
  const vote = [...voteRows][0];
  if (vote?.project_ref) {
    const projectId = vote.project_ref.split(":")[1];
    const [row] = await db.execute<{ name: string }>(
      dsql`select name from projects where id = ${projectId}`,
    );
    if (row) {
      // Strong when multiple neighbours agree or one is very close.
      const strong = vote.n >= 2 || Number(vote.best) < 0.42;
      return {
        id: projectId,
        name: row.name,
        distance: Number(vote.best),
        confidence: strong ? "strong" : "possible",
      };
    }
  }

  // 2 — direct project embedding (fallback).
  const projRows = await db.execute<{
    id: string;
    name: string;
    distance: number;
  }>(dsql`
    with target as (
      select embedding from search_index
       where kind = ${kind} and source_id = ${sourceId} and embedding is not null)
    select p.id::text, p.name,
           (si.embedding <=> (select embedding from target))::float8 as distance
      from search_index si
      join projects p on p.id::text = si.source_id
     where si.kind = 'project' and si.embedding is not null
       and (select embedding from target) is not null
     order by distance asc
     limit 1
  `);
  const top = [...projRows][0];
  if (top && Number(top.distance) <= PROJECT_POSSIBLE) {
    return {
      id: top.id,
      name: top.name,
      distance: Number(top.distance),
      confidence: Number(top.distance) <= PROJECT_STRONG ? "strong" : "possible",
    };
  }
  return null;
}

/**
 * Best-fit ACTIVE project for a piece of free text (e.g. a freshly-captured
 * inbox item), by embedding the text and comparing to project embeddings.
 * Same confidence gates as the item-based matcher. Never throws — returns null
 * when embeddings aren't ready or nothing is close enough.
 */
export async function matchProjectByText(
  text: string,
): Promise<{ id: string; name: string; confidence: "strong" | "possible" } | null> {
  const clean = text.trim();
  if (!clean) return null;
  try {
    const vec = await embedText(clean.slice(0, 2000));
    const rows = await db.execute<{ id: string; name: string; distance: number }>(dsql`
      select p.id::text, p.name,
             (si.embedding <=> ${toVec(vec)}::vector)::float8 as distance
        from search_index si
        join projects p on p.id::text = si.source_id
       where si.kind = 'project' and si.embedding is not null and p.status = 'active'
       order by distance asc
       limit 1
    `);
    const top = [...rows][0];
    if (top && Number(top.distance) <= PROJECT_POSSIBLE) {
      return {
        id: top.id,
        name: top.name,
        confidence: Number(top.distance) <= PROJECT_STRONG ? "strong" : "possible",
      };
    }
  } catch {
    // embeddings not ready / ollama down — no match rather than an error
  }
  return null;
}

/**
 * Neighbour-vote project match for free text: which project do this text's
 * closest notes/tasks already belong to? Robust even when a project's own
 * description is thin, because it uses the project's REAL contents, not a
 * synthetic project vector. "Strong" when ≥2 neighbours agree or one is very
 * close. Text-based sibling of suggestProject (which works from an item id).
 */
export async function suggestProjectByText(
  text: string,
): Promise<{ id: string; confidence: "strong" | "possible" } | null> {
  const clean = text.trim();
  if (!clean) return null;
  try {
    const v = toVec(await embedText(clean.slice(0, 2000)));
    const rows = await db.execute<{ project_ref: string; best: number; n: number }>(dsql`
      with neighbours as (
        select ref as project_ref, (si.embedding <=> ${v}::vector) as d
          from search_index si, jsonb_array_elements_text(si.project_refs) ref
         where si.kind in ('note','task') and si.embedding is not null
           and ref like 'projects:%'
           and (si.embedding <=> ${v}::vector) < ${RELATED_MAX_DISTANCE})
      select project_ref, min(d)::float8 as best, count(*)::int as n
        from neighbours
       group by project_ref
       order by sum(${RELATED_MAX_DISTANCE} - d) desc
       limit 1
    `);
    const vote = [...rows][0];
    if (vote?.project_ref) {
      return {
        id: vote.project_ref.split(":")[1],
        confidence: vote.n >= 2 || Number(vote.best) < 0.42 ? "strong" : "possible",
      };
    }
  } catch {
    // embeddings not ready / ollama down — no vote rather than an error
  }
  return null;
}

/**
 * Decide a card's project anchor from EVIDENCE about the card itself, not from
 * the raising model's guess — because a weak agent stamps the week's dominant
 * project on everything ("consult a lawyer" → GitLocker). Two independent
 * signals: the enriched project embedding (matchProjectByText) and a
 * neighbour vote over real linked items (suggestProjectByText). Abstain by
 * default — a wrong tag is worse than none — anchoring only when the evidence
 * is clear:
 *   • both signals agree                          → anchor
 *   • the neighbour vote is strong                → anchor
 *   • the embedding is strong and the vote agrees → anchor
 *   • the agent's own ref is corroborated by either signal → keep it
 *   • otherwise                                   → null (leave it personal)
 */
export async function groundProjectRef(
  projectRef: string | null | undefined,
  text: string,
): Promise<string | null> {
  const agentId = projectRef
    ? projectRef.startsWith("projects:")
      ? projectRef.slice("projects:".length)
      : projectRef
    : null;

  const [emb, vote] = await Promise.all([
    matchProjectByText(text),
    suggestProjectByText(text),
  ]);

  let id: string | null = null;
  if (emb && vote && emb.id === vote.id) id = emb.id; // both agree
  else if (vote?.confidence === "strong") id = vote.id; // strong neighbour evidence
  else if (emb?.confidence === "strong" && (!vote || vote.id === emb.id)) id = emb.id;
  // Agent's guess counts only when a semantic signal (even a weaker one) backs it.
  else if (agentId && (emb?.id === agentId || vote?.id === agentId)) id = agentId;

  return id ? `projects:${id}` : null;
}

/**
 * The relations engine: from any source item, return a best-fit project
 * suggestion (with confidence) plus quality-gated, cross-type neighbours.
 * Never throws — degrades to empty when embeddings aren't ready yet.
 */
export async function getConnections(
  sourceKind: "note" | "idea" | "knowledge",
  sourceId: string,
  opts: { limit?: number; currentProjectId?: string | null } = {},
): Promise<Connections> {
  if (!["note", "idea", "knowledge"].includes(sourceKind))
    return { projectSuggestion: null, related: [] };
  const limit = opts.limit ?? 6;

  try {
    let projectSuggestion: ProjectSuggestion | null = null;
    if (!opts.currentProjectId) {
      projectSuggestion = await suggestProject(sourceKind, sourceId);
    }

    // Cross-type neighbours, all from the one index. Self-exclude by (kind,id).
    const rows = await db.execute<{
      kind: string;
      id: string;
      title: string;
      snippet: string | null;
      distance: number;
    }>(dsql`
      with target as (
        select embedding from search_index
         where kind = ${sourceKind} and source_id = ${sourceId} and embedding is not null)
      select si.kind, si.source_id as id, si.title, si.snippet,
             (si.embedding <=> (select embedding from target)) as distance
        from search_index si
       where si.kind in ('note','idea','knowledge','vault') and si.embedding is not null
         and not (si.kind = ${sourceKind} and si.source_id = ${sourceId})
         and (select embedding from target) is not null
       order by distance asc
       limit ${limit + 4}
    `);

    const related: Connection[] = [...rows]
      .map((r) => ({
        kind: r.kind as Connection["kind"],
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        href: hitHref(r.kind, r.id),
        distance: Number(r.distance),
      }))
      .filter((c) => c.distance <= RELATED_MAX_DISTANCE)
      .slice(0, limit);

    return { projectSuggestion, related };
  } catch {
    return { projectSuggestion: null, related: [] };
  }
}
