/**
 * Local-inference queue. Ollama and MLX run on ONE machine with finite GPU/RAM;
 * firing several model calls at once makes it evict + reload models (thrash),
 * which surfaces as 120s knowledge-enrichment timeouts ("Request was aborted")
 * and intermittent `nomic-embed` 500s. This gate serializes local model calls so
 * they execute one at a time, fairly, per call — the machine stays on one model,
 * so each call is fast instead of thrashing. Cloud providers (Anthropic, Gemini,
 * OpenRouter, nVidia) bypass this entirely.
 *
 * Scope is per-process, which is what matters: the WORKER is the heavy caller —
 * agents, the embedding sweep, knowledge enrichment and Telegram ingest all run
 * in that one process — so serializing within it removes the real contention.
 *
 * Concurrency is `AIOS_LOCAL_INFERENCE_CONCURRENCY` (default 1). Raise it only if
 * the machine can genuinely hold that many models resident at once.
 */
import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "@/core/db/client";
import { modelCalls } from "@/core/db/schema/model-calls";
import { GENERATION_STALE_MS } from "./model-track";

const LIMIT = Math.max(1, Number(process.env.AIOS_LOCAL_INFERENCE_CONCURRENCY ?? 1));

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < LIMIT) {
    active++;
    return Promise.resolve();
  }
  // Parked; when released, the waiter is handed the slot directly (active kept).
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

/** Run an async fn while holding a local-inference slot (e.g. one embed call). */
export async function withLocalSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Acquire a slot and return a release fn — for holding the slot across a section
 * that yields (a streaming model call) rather than a single await.
 *
 * IMPORTANT: hold this only around the actual model generation, NOT across a
 * whole agent run. An agent run runs TOOLS between model turns, and a tool can
 * itself make a local call (attention.raise → embedText, projects.focusNext →
 * recall). If the run held the slot for its whole lifetime, that nested call
 * would wait for a slot the run itself holds → deadlock (LIMIT=1). Releasing
 * between turns keeps model generation serialized (the anti-thrash goal) while
 * letting a tool's embed acquire the slot freely.
 */
export async function acquireLocalSlot(): Promise<() => void> {
  await acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/**
 * Local runtimes whose GPU/RAM an agent's model call contends for. A live
 * `generation` row on either means the box is actively inferring right now.
 */
const LOCAL_PROVIDERS = ["ollama", "mlx"];

/**
 * Count LIVE local generation calls (other than `exceptParentId`'s own) via the
 * cross-process model-call registry — web (deep report, chat, ask) and worker
 * (agents, sub-tasks) both write it, so this sees contention the in-process slot
 * count above cannot. Embeddings are excluded: nomic-embed is tiny and already
 * serialized by the local slot; the contention that EVICTS a resident model is
 * the big chat/report/agent generations. Orphaned rows (crashed process) are
 * ignored once older than the generation staleness cutoff.
 */
async function activeLocalGenerations(exceptParentId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - GENERATION_STALE_MS);
  const rows = await db
    .select({ id: modelCalls.id })
    .from(modelCalls)
    .where(
      and(
        eq(modelCalls.kind, "generation"),
        inArray(modelCalls.provider, LOCAL_PROVIDERS),
        gt(modelCalls.startedAt, cutoff),
        exceptParentId
          ? or(
              isNull(modelCalls.parentId),
              ne(modelCalls.parentId, exceptParentId),
            )
          : undefined,
      ),
    );
  return rows.length;
}

export interface LocalIdleOptions {
  /** Cap the wait so a stuck/long-resident external call can't starve the agent. */
  maxWaitMs?: number;
  /** Poll cadence while parked. */
  pollMs?: number;
  /** Ignore this run's own generation rows (e.g. a prior fallback attempt). */
  exceptParentId?: string;
  /** Called on each park (loop), with the busy count + elapsed ms — for a
   *  heartbeat write so a waiting run isn't swept as orphaned, and telemetry. */
  onWait?: (busy: number, waitedMs: number) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Block until no OTHER local model generation is in flight, so an agent's local
 * model call doesn't collide with LM Studio / Ollama already serving the deep
 * report, chat, or another agent — the collision forces a model swap that evicts
 * a resident model ("Model unloaded" / "terminated" thrash). Because a
 * generation ROW exists only while a call is actually generating (Ollama's
 * keep_alive keeps the model RESIDENT but writes no row when idle), this
 * normally returns the instant the current call finishes. Bounded by maxWaitMs
 * so a genuinely stuck external call never starves the agent. A gate error never
 * blocks the run (returns as idle). Cloud-provider agents should not call this.
 */
export async function waitForLocalIdle(
  opts: LocalIdleOptions = {},
): Promise<{ waitedMs: number; timedOut: boolean }> {
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 1500;
  const start = Date.now();
  let waited = 0;
  while (true) {
    if (opts.signal?.aborted) return { waitedMs: waited, timedOut: false };
    let busy: number;
    try {
      busy = await activeLocalGenerations(opts.exceptParentId);
    } catch {
      return { waitedMs: waited, timedOut: false }; // never block a run on a gate hiccup
    }
    if (busy === 0) return { waitedMs: waited, timedOut: false };
    waited = Date.now() - start;
    if (waited >= maxWaitMs) return { waitedMs: waited, timedOut: true };
    await opts.onWait?.(busy, waited);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
