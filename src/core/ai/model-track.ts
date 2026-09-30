/**
 * The model-call chokepoint. Every generation flows through a provider's run()
 * (wrapped in core/ai/routing); every embedding through embedText. Wrapping
 * those two points makes EVERY model invocation appear in the run queue
 * (core/db/schema/model-calls) — by construction, so a new call site can't
 * silently escape (it's recorded as "unknown" until it passes a `track`).
 *
 * A run's optional `track` (AIRunOptions.track) labels the call and, when its
 * parentKind names an already-queued run (agent/chat/workbench), lets the queue
 * fold it into the rich parent row rather than showing a bare generation row.
 * Tool sub-calls (agent.subtask, gates) pass their OWN track, so they appear as
 * their own rows — nested work stays visible.
 */
import { hostname } from "node:os";
import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { modelCalls } from "@/core/db/schema/model-calls";
import type { AIEvent, ModelTrack } from "./provider";

/** A single coalesced embedding row (upserted, throttled) — embeddings are far
 *  too frequent for a row per call. */
const EMBED_ROW_ID = "00000000-0000-0000-0000-0000000e3bed";
/** Generation orphan cutoff (a crashed process's row). Longer than any single
 *  call — a deep report can run minutes — so a live call is never hidden. */
export const GENERATION_STALE_MS = 30 * 60_000;
/** How long the coalesced embedding heartbeat counts as "active" after the last
 *  embed. */
export const EMBED_FRESH_MS = 30_000;

/** This process, as recorded on the rows it opens. */
const OWNER = `${hostname()}:${process.pid}`;

/** Is a process on this host still running? (signal 0 = existence check) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function notify() {
  try {
    await sql.notify("model_calls", "");
  } catch {
    /* best-effort */
  }
}

/** Open a live generation row; returns its id (null on failure — best-effort,
 *  tracking must never break a model call). */
async function openCall(
  provider: string,
  model: string,
  track: ModelTrack | undefined,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(modelCalls)
      .values({
        kind: "generation",
        provider,
        model: model.slice(0, 200),
        label: (track?.label ?? "").slice(0, 200),
        source: track?.source ?? "unknown",
        parentKind: track?.parentKind ?? null,
        parentId: track?.parentId ?? null,
        owner: OWNER,
      })
      .returning({ id: modelCalls.id });
    void notify();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function closeCall(id: string | null) {
  if (!id) return;
  try {
    await db.delete(modelCalls).where(eq(modelCalls.id, id));
    void notify();
  } catch {
    /* best-effort */
  }
}

/**
 * Wrap a provider's event stream so a live row exists for exactly the duration
 * of the call. The row opens when iteration starts (the real call begin) and is
 * removed in `finally` — on normal end, break, or throw.
 */
export async function* trackGeneration(
  provider: string,
  model: string,
  track: ModelTrack | undefined,
  gen: AsyncIterable<AIEvent>,
): AsyncIterable<AIEvent> {
  const id = await openCall(provider, model, track);
  try {
    yield* gen;
  } finally {
    await closeCall(id);
  }
}

let lastEmbedBeat = 0;
/**
 * Mark embedding activity. Coalesced into ONE row and throttled per process, so
 * a reindex sweep of thousands of embeds costs a handful of writes, not two per
 * call. The queue shows it as "active" for EMBED_FRESH_MS after the last beat.
 */
export async function embeddingHeartbeat(model: string): Promise<void> {
  const now = Date.now();
  if (now - lastEmbedBeat < 3000) return;
  lastEmbedBeat = now;
  try {
    await db
      .insert(modelCalls)
      .values({
        id: EMBED_ROW_ID,
        kind: "embedding",
        provider: "ollama",
        model: model.slice(0, 200),
        label: "embedding",
        source: "embedding",
      })
      .onConflictDoUpdate({
        target: modelCalls.id,
        set: { startedAt: new Date(), model: model.slice(0, 200) },
      });
    void notify();
  } catch {
    /* best-effort */
  }
}

/** Record a direct (non-provider) model call — e.g. a raw Ollama fetch — in the
 *  queue for exactly its duration, like a provider run. */
export async function withTrackedCall<T>(
  provider: string,
  model: string,
  track: ModelTrack,
  fn: () => Promise<T>,
): Promise<T> {
  const id = await openCall(provider, model, track);
  try {
    return await fn();
  } finally {
    await closeCall(id);
  }
}

/** Remove orphaned rows: crashed-process generation rows and a stale embedding
 *  heartbeat. Called periodically by the worker. */
export async function sweepStaleModelCalls(): Promise<number> {
  const genCutoff = new Date(Date.now() - GENERATION_STALE_MS);
  const embedCutoff = new Date(Date.now() - EMBED_FRESH_MS * 4);
  try {
    const gone = await db
      .delete(modelCalls)
      .where(
        or(
          and(eq(modelCalls.kind, "generation"), lt(modelCalls.startedAt, genCutoff)),
          and(eq(modelCalls.kind, "embedding"), lt(modelCalls.startedAt, embedCutoff)),
        ),
      )
      .returning({ id: modelCalls.id });
    // Rows whose process on this host has exited (a deploy/restart mid-call)
    // are dead now — don't wait out the 30-minute cutoff.
    const host = hostname();
    const owned = await db
      .select({ id: modelCalls.id, owner: modelCalls.owner })
      .from(modelCalls)
      .where(and(eq(modelCalls.kind, "generation"), isNotNull(modelCalls.owner)));
    const dead = owned.filter((r) => {
      const i = r.owner!.lastIndexOf(":");
      const pid = Number(r.owner!.slice(i + 1));
      return r.owner!.slice(0, i) === host && Number.isInteger(pid) && !alive(pid);
    });
    for (const r of dead) await db.delete(modelCalls).where(eq(modelCalls.id, r.id));
    const total = gone.length + dead.length;
    if (total) void notify();
    return total;
  } catch {
    return 0;
  }
}
