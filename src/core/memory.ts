import { and, asc, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import {
  MEMORY_TIER,
  memoryBlocks,
  memoryEntries,
  type MemoryEntryKind,
} from "@/core/db/schema/memory";

/** Hard caps that keep memory strong but bounded. */
const MAX_BLOCKS = 12;
const DEFAULT_BLOCK_LIMIT = 1200;
/**
 * The ALWAYS-INJECTED budget. Blocks render into EVERY AI call, so the rendered
 * context is capped here regardless of how many blocks exist or how full they
 * are — the injected memory can never grow endless. Per-block char limits +
 * MAX_BLOCKS bound it too, but this is the belt-and-suspenders global ceiling.
 */
const MAX_INJECTED_CHARS = 6000;
/** Below this cosine distance two archival entries are the same memory — a
 *  re-`remember` of a near-identical fact/lesson is deduped, not stacked. */
const MEMORY_DUP_DISTANCE = 0.12;

const DEFAULT_BLOCKS = [
  {
    label: "who_i_am",
    description: "Who the user is: role, business, what they care about.",
  },
  {
    label: "current_focus",
    description: "What the user is actively working on right now.",
  },
  {
    label: "preferences",
    description:
      "How the user likes things done: tone, formats, working habits.",
  },
  {
    label: "active_projects",
    description: "Short live summary of key projects and their state.",
  },
] as const;

export async function ensureDefaultMemoryBlocks() {
  // Read-first: only write when blocks are actually missing, so the hot path
  // (every AI call renders memory) stays a plain SELECT.
  const existing = await db
    .select({ label: memoryBlocks.label })
    .from(memoryBlocks);
  if (existing.length >= DEFAULT_BLOCKS.length) return;
  const have = new Set(existing.map((r) => r.label));
  const missing = DEFAULT_BLOCKS.filter((b) => !have.has(b.label));
  if (missing.length) {
    await db
      .insert(memoryBlocks)
      .values(missing.map((b) => ({ ...b })))
      .onConflictDoNothing();
  }
}

export async function listMemoryBlocks() {
  await ensureDefaultMemoryBlocks();
  return db.select().from(memoryBlocks).orderBy(asc(memoryBlocks.label));
}

/** Rendered for system prompts. Never throws — memory being unavailable must
 *  not take down chat, agents, or pages. */
export async function renderMemoryContext(): Promise<string> {
  let blocks;
  try {
    blocks = await listMemoryBlocks();
  } catch {
    return "";
  }
  // Token discipline: only non-empty blocks render; empty ones collapse to one
  // line. The core defaults render first (canonical order), then the rest — so
  // if the injection budget is hit, the least-important dynamic blocks are what
  // gets trimmed, never who_i_am / current_focus.
  // Core defaults first, then the learned procedural rules — both are protected
  // from trimming ahead of any other dynamic block.
  const priority: string[] = [
    ...DEFAULT_BLOCKS.map((b) => b.label),
    "operating_rules",
  ];
  const rank = (label: string) => {
    const i = priority.indexOf(label);
    return i < 0 ? priority.length : i;
  };
  const filled = blocks
    .filter((b) => b.value.trim())
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
  const empty = blocks.filter((b) => !b.value.trim()).map((b) => b.label);

  // Fill up to the hard injection budget; truncate the block that would overflow
  // and stop — the always-injected memory is bounded no matter what.
  const parts: string[] = [];
  let used = 0;
  let trimmed = false;
  for (const b of filled) {
    const remaining = MAX_INJECTED_CHARS - used;
    if (remaining <= 80) {
      trimmed = true;
      break;
    }
    const val = b.value.trim();
    const shown =
      val.length <= remaining ? val : val.slice(0, remaining - 1).trimEnd() + "…";
    if (shown.length < val.length) trimmed = true;
    const chunk = `<${b.label}>\n${shown}\n</${b.label}>`;
    parts.push(chunk);
    used += chunk.length + 1;
  }

  return [
    "PERSISTENT MEMORY (shared across chat and all agents; keep it current with the memory.update tool):",
    ...parts,
    ...(empty.length
      ? [`(empty blocks awaiting content: ${empty.join(", ")})`]
      : []),
    ...(trimmed
      ? ["(memory trimmed to the injection budget — compress a block with memory.update)"]
      : []),
    "Long-tail memory: memory.recall to search past decisions/lessons; memory.remember to store durable ones.",
  ].join("\n");
}

export async function updateMemoryBlock(
  label: string,
  value: string,
  mode: "replace" | "append" = "replace",
  description?: string,
) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new Error("memory block label required");

  let [block] = await db
    .select()
    .from(memoryBlocks)
    .where(eq(memoryBlocks.label, slug));

  // Dynamic blocks: create on first write, bounded by MAX_BLOCKS.
  if (!block) {
    const count = (await db.select({ l: memoryBlocks.label }).from(memoryBlocks))
      .length;
    if (count >= MAX_BLOCKS) {
      throw new Error(
        `memory block limit reached (${MAX_BLOCKS}) — reuse or clear an existing block instead of creating "${slug}"`,
      );
    }
    [block] = await db
      .insert(memoryBlocks)
      .values({
        label: slug,
        description: description?.trim() || "Agent/user-defined context block.",
        charLimit: DEFAULT_BLOCK_LIMIT,
      })
      .returning();
  }

  const next =
    mode === "append" && block.value.trim()
      ? `${block.value.trim()}\n${value.trim()}`
      : value.trim();
  if (next.length > block.charLimit) {
    throw new Error(
      `memory block "${slug}" would exceed its ${block.charLimit}-char budget (${next.length}); compress the content instead`,
    );
  }

  // Provenance: a replaced non-trivial value is never lost — it becomes an
  // archival entry, searchable via memory.recall.
  if (mode === "replace" && block.value.trim() && block.value.trim() !== next) {
    await rememberEntry({
      kind: "superseded",
      text: `[${slug}] ${block.value.trim()}`,
      source: `block:${slug}`,
    });
  }

  await db
    .update(memoryBlocks)
    .set({ value: next, updatedAt: new Date() })
    .where(eq(memoryBlocks.label, slug));
  return next;
}

/** Create an empty block explicitly (Settings UI). */
export async function createMemoryBlockDef(label: string, description: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new Error("label required");
  const count = (await db.select({ l: memoryBlocks.label }).from(memoryBlocks))
    .length;
  if (count >= MAX_BLOCKS) {
    throw new Error(`memory block limit reached (${MAX_BLOCKS})`);
  }
  await db
    .insert(memoryBlocks)
    .values({
      label: slug,
      description: description.trim() || "User-defined context block.",
      charLimit: DEFAULT_BLOCK_LIMIT,
    })
    .onConflictDoNothing();
}

/**
 * Append to archival memory — deduped so re-`remember`ing a near-identical fact
 * doesn't stack. Best-effort semantic match via the unified index (falls back to
 * exact-text when embeddings aren't ready); a hit returns the existing row
 * instead of inserting. The new row is embedded inline so the next recall/dedup
 * sees it immediately rather than waiting for the 2-min sweep.
 */
export async function rememberEntry(input: {
  kind: MemoryEntryKind;
  text: string;
  source: string;
}) {
  const text = input.text.trim().slice(0, 2000);
  if (!text) throw new Error("memory entry text required");
  let embedding: number[] | null = null;
  try {
    const { embedText } = await import("@/core/embeddings");
    embedding = await embedText(text);
    const vec = `[${embedding.join(",")}]`;
    const near = await db.execute<{ id: string; distance: number }>(dsql`
      select m.id, (si.embedding <=> ${vec}::vector) as distance
        from search_index si
        join memory_entries m on m.id::text = si.source_id
       where si.kind = 'memory' and si.embedding is not null
       order by distance asc
       limit 1`);
    const hit = [...near][0];
    if (hit && Number(hit.distance) < MEMORY_DUP_DISTANCE) {
      const [existing] = await db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.id, hit.id))
        .limit(1);
      if (existing) return existing; // dedup: don't stack a near-identical memory
    }
  } catch {
    // Embeddings unavailable — fall back to exact-text dedup among stored rows.
    const [dupe] = await db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.text, text))
      .limit(1);
    if (dupe) return dupe;
  }
  const [row] = await db
    .insert(memoryEntries)
    .values({ kind: input.kind, text, source: input.source })
    .returning();
  try {
    const { indexRow } = await import("@/core/search-index");
    await indexRow("memory", row.id, embedding); // embed now for immediate recall/dedup
  } catch {
    // index is best-effort; the sync sweep backfills the embedding otherwise.
  }
  return row;
}

/**
 * Block-freshness health-check. Bounding the injected snapshot only stays safe
 * if that snapshot keeps being refreshed — otherwise the always-injected memory
 * silently rots. The weekly-consolidated blocks (current_focus, active_projects)
 * are expected to update ~weekly; if one goes past STALE_BLOCK_DAYS the
 * consolidation agent has likely stopped, and the daily maintenance sweep
 * surfaces it. This is what makes "bounded injection doesn't harm growth" true.
 */
const STALE_BLOCK_DAYS = 9;
const WEEKLY_BLOCKS = ["current_focus", "active_projects"];
export async function checkMemoryFreshness(): Promise<
  { label: string; ageDays: number }[]
> {
  const rows = await db
    .select()
    .from(memoryBlocks)
    .where(inArray(memoryBlocks.label, WEEKLY_BLOCKS));
  const now = Date.now();
  return rows
    .filter((b) => b.value.trim()) // only content that HAD a value can go stale
    .map((b) => ({
      label: b.label,
      ageDays: Math.floor((now - +new Date(b.updatedAt)) / 86_400_000),
    }))
    .filter((x) => x.ageDays >= STALE_BLOCK_DAYS);
}

/**
 * Keep the archival tier bounded — low-value entries age out and a hard total
 * cap trims the oldest. Deterministic (no LLM), idempotent, cheap; runs on a
 * daily maintenance sweep. Durable kinds (decision, lesson) are kept longest.
 * Orphaned search_index rows are cleaned by the index sync's own orphan pass.
 */
export async function pruneMemoryEntries(): Promise<{ pruned: number }> {
  const MAX_ENTRIES = 5000;
  // 1. Age out transient kinds: events after 90 days, superseded block history
  //    after 60 (its purpose — a recallable trail of a replaced block — is spent).
  const aged = await db
    .delete(memoryEntries)
    .where(
      dsql`(${memoryEntries.kind} = 'event' and ${memoryEntries.createdAt} < now() - interval '90 days')
        or (${memoryEntries.kind} = 'superseded' and ${memoryEntries.createdAt} < now() - interval '60 days')`,
    )
    .returning({ id: memoryEntries.id });
  let pruned = aged.length;
  // 2. Hard ceiling: if still very large, drop the oldest non-durable rows
  //    (never decisions/lessons) beyond the cap.
  const [{ count }] = await db
    .select({ count: dsql<number>`count(*)::int` })
    .from(memoryEntries);
  const over = Number(count) - MAX_ENTRIES;
  if (over > 0) {
    const dropped = await db.execute<{ id: string }>(dsql`
      delete from memory_entries where id in (
        select id from memory_entries
         where kind in ('event', 'superseded', 'fact')
         order by created_at asc
         limit ${over}
      ) returning id`);
    pruned += [...dropped].length;
  }
  return { pruned };
}

/**
 * Distill the archive by compacting near-DUPLICATE entries that slipped past
 * write-time dedup (embedding not ready at write, or stored before dedup
 * existed). For each near-identical cluster keep the NEWEST and drop the older
 * ones — removing redundancy so the long-tail stays high-signal, with NO LLM,
 * NO growth of the injected snapshot, and never touching a decision/lesson.
 * Distance 0.10 (tighter than the 0.12 write-dedup) so only genuine duplicates
 * merge, never distinct-but-related memories. Orphaned index rows are cleaned by
 * the index sync's own orphan pass.
 */
export async function compactMemoryEntries(): Promise<{ merged: number }> {
  const rows = await db.execute<{ id: string }>(dsql`
    delete from memory_entries where id in (
      select ma.id
        from search_index sa
        join search_index sb
          on sb.kind = 'memory' and sa.kind = 'memory'
         and sa.source_id <> sb.source_id
         and sa.embedding is not null and sb.embedding is not null
         and (sa.embedding <=> sb.embedding) < 0.10
        join memory_entries ma on ma.id::text = sa.source_id
        join memory_entries mb on mb.id::text = sb.source_id
       where ma.created_at < mb.created_at
         and ma.kind not in ('decision', 'lesson')
    )
    returning id`);
  return { merged: [...rows].length };
}

/** Semantic recall over archival memory, with keyword fallback while
 *  embeddings backfill. Never throws — recall failures degrade to []. */
export async function recallEntries(
  query: string,
  limit = 6,
): Promise<{ kind: string; text: string; when: Date; source: string }[]> {
  try {
    const { embedText } = await import("@/core/embeddings");
    const vec = `[${(await embedText(query)).join(",")}]`;
    // Memory now embeds through the unified index (kind='memory'); rank there,
    // then fetch the full rows here so recall still returns real entry text.
    const rows = await db.execute<{
      kind: string;
      text: string;
      created_at: Date;
      source: string;
    }>(dsql`
      with ranked as (
        select source_id, (embedding <=> ${vec}::vector) as distance
          from search_index
         where kind = 'memory' and embedding is not null
         order by distance asc
         limit ${limit})
      select m.kind, m.text, m.created_at, m.source
        from memory_entries m
        join ranked r on r.source_id = m.id::text
       order by r.distance asc
    `);
    if ([...rows].length > 0) {
      return [...rows].map((r) => ({
        kind: r.kind,
        // Snippet, not full text — recall results feed back into prompts.
        text: r.text.length > 500 ? r.text.slice(0, 500) + "…" : r.text,
        when: new Date(r.created_at),
        source: r.source,
      }));
    }
  } catch {
    // fall through to keyword search
  }
  const fallback = await db
    .select()
    .from(memoryEntries)
    .where(dsql`${memoryEntries.text} ilike ${"%" + query + "%"}`)
    .orderBy(desc(memoryEntries.createdAt))
    .limit(limit);
  return fallback.map((r) => ({
    kind: r.kind,
    text: r.text,
    when: r.createdAt,
    source: r.source,
  }));
}

/**
 * Recent long-tail entries for CONSOLIDATION — the raw material a distiller
 * reviews to abstract episodic events into durable facts / procedural rules.
 * Optionally filtered to one tier (episodic | semantic | procedural).
 */
export async function reviewEntries(
  tier?: "episodic" | "semantic" | "procedural",
  limit = 20,
): Promise<
  { id: string; kind: string; tier: string; text: string; when: Date; source: string }[]
> {
  const kinds = tier
    ? (Object.keys(MEMORY_TIER) as MemoryEntryKind[]).filter(
        (k) => MEMORY_TIER[k] === tier,
      )
    : undefined;
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(kinds ? inArray(memoryEntries.kind, kinds) : undefined)
    .orderBy(desc(memoryEntries.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    tier: MEMORY_TIER[r.kind],
    text: r.text,
    when: r.createdAt,
    source: r.source,
  }));
}

/**
 * Unified SEMANTIC recall across the whole ecosystem's index — not just memory,
 * but the user's knowledge base, notes and Obsidian vault. This is how ecosystem
 * data is delivered INTO the memory context: one embedding query over the shared
 * `search_index` (which already covers all sources). Best-effort → [] on any
 * failure. Returns labeled snippets so the caller can show provenance.
 */
export async function recallSemantic(
  query: string,
  opts: { kinds?: string[]; limit?: number } = {},
): Promise<{ kind: string; text: string; href: string | null }[]> {
  const kinds = opts.kinds ?? ["memory", "knowledge", "note", "vault"];
  const limit = opts.limit ?? 6;
  const q = query.trim();
  if (!q) return [];
  try {
    const { embedText } = await import("@/core/embeddings");
    const vec = `[${(await embedText(q)).join(",")}]`;
    const kindList = dsql.join(
      kinds.map((k) => dsql`${k}`),
      dsql`, `,
    );
    // Tier discipline: from the memory index include only SEMANTIC + PROCEDURAL
    // entries (facts/decisions/lessons/policies) — episodic noise (superseded
    // block-dumps, raw events) never belongs in retrieval-augmented context.
    // Other ecosystem kinds (knowledge/note/vault…) pass through whole.
    const rows = await db.execute<{
      kind: string;
      snippet: string | null;
      title: string | null;
      href: string | null;
      distance: number;
    }>(dsql`
      select si.kind, si.snippet, si.title, si.href,
             (si.embedding <=> ${vec}::vector) as distance
        from search_index si
        left join memory_entries m
          on si.kind = 'memory' and m.id::text = si.source_id
       where si.kind in (${kindList}) and si.embedding is not null
         and (si.kind <> 'memory'
              or m.kind in ('fact', 'decision', 'lesson', 'policy'))
       -- Hybrid rank: semantic distance, minus a small recency boost and a tier
       -- boost (procedural rules > semantic facts) so learned how-to and fresh
       -- knowledge surface above stale trivia at similar relevance.
       order by (
           (si.embedding <=> ${vec}::vector)
           - case when si.updated_at > now() - interval '30 days' then 0.04 else 0 end
           - case when m.kind in ('lesson', 'policy') then 0.05
                  when m.kind in ('fact', 'decision') then 0.02
                  else 0 end
         ) asc
       limit ${limit}`);
    return [...rows]
      .map((r) => ({
        kind: r.kind,
        text: (r.snippet ?? r.title ?? "").trim().slice(0, 400),
        href: r.href,
      }))
      .filter((r) => r.text);
  } catch {
    return [];
  }
}

// ── Per-agent self-learning ──────────────────────────────────────────────────
// The archival `source` field already stamps who wrote a memory
// (`agent-run:<name>`). These functions turn that provenance into a real
// feedback loop: an agent RECALLS only its own past lessons at run start, and
// REFLECTS on each run to write a fresh one. The weekly distill still abstracts
// the global picture; this is the tight, per-agent inner loop.

/** The lessons THIS agent wrote about itself, newest first. Best-effort. */
export async function recallAgentLessons(
  agentName: string,
  limit = 5,
): Promise<string[]> {
  try {
    const rows = await db
      .select({ text: memoryEntries.text })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.source, `agent-run:${agentName}`),
          eq(memoryEntries.kind, "lesson"),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(limit);
    return rows.map((r) => r.text).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Reflect on a just-finished run and, if there is something worth remembering,
 * store ONE terse lesson scoped to this agent (kind `lesson`, source
 * `agent-run:<name>`) so its next run recalls it. Runs on the free local
 * `memory.distill` route; fully best-effort — never affects the run.
 */
export async function reflectOnRun(input: {
  agentName: string;
  prompt: string;
  status: string;
  error?: string | null;
  report?: string | null;
}): Promise<void> {
  try {
    const { resolveRoute } = await import("@/core/ai/routing");
    const route = await resolveRoute("memory.distill");
    const system = [
      "You are the reflective memory of an autonomous background agent. In ONE terse sentence, capture a durable LESSON for this agent's NEXT run — a concrete 'next time, do/avoid X' grounded in what just happened (a recurring failure, a wasteful path, a heuristic that worked).",
      "If the run was unremarkable and there is nothing worth remembering, reply with exactly: NONE.",
      "No preamble, no quotes, no markdown — output only the one-sentence lesson, or NONE.",
    ].join("\n");
    const user = [
      `AGENT: ${input.agentName}`,
      `TASK: ${input.prompt.slice(0, 700)}`,
      `OUTCOME: ${input.status}${input.error ? ` — ${input.error.slice(0, 240)}` : ""}`,
      input.report ? `WHAT IT REPORTED:\n${input.report.slice(0, 700)}` : "",
    ].join("\n");

    let text = "";
    for await (const ev of route.provider.run({
      system,
      messages: [{ role: "user", content: `/no_think\n${user}` }],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
    })) {
      if (ev.type === "done") text = ev.text;
      else if (ev.type === "text" && !text) text += ev.text;
    }
    const lesson = text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .trim();
    if (!lesson || /^none\.?$/i.test(lesson) || lesson.length < 12) return;
    await rememberEntry({
      kind: "lesson",
      source: `agent-run:${input.agentName}`,
      text: lesson.slice(0, 400),
    });
  } catch {
    // best-effort — reflection failure must never affect the run
  }
}
