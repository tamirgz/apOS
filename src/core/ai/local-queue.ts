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
import { and, gt, inArray } from "drizzle-orm";
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

/** Local runtimes whose GPU/RAM an agent's model call contends for. */
const LOCAL_PROVIDERS = ["ollama", "mlx"];
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
/** The tiny always-on embedder. It coexists with any chat model for ~370 MB and
 *  is needed constantly, so it is never a "contender" and never unloaded. */
const EMBED_MODEL_PREFIX = "nomic-embed-text";

/** A model that can share the box with `myModel` without forcing a swap: the SAME
 *  model (already resident — no reload) or the tiny embedder. */
function coexists(model: string, myModel: string): boolean {
  return model === myModel || model.startsWith(EMBED_MODEL_PREFIX);
}

/**
 * How many LIVE local calls are running a DIFFERENT heavy model than `myModel` —
 * the only calls whose model an agent's load would swap out. Read from the
 * cross-process model-call registry (web: report/chat/ask; worker: agents/gates/
 * sub-tasks), so it sees contention the in-process slot above cannot. A call on
 * `myModel` (same resident model) or the tiny embedder is NOT a contender.
 * Orphaned rows past the staleness cutoff are ignored.
 */
async function activeLocalContenders(myModel: string): Promise<number> {
  const cutoff = new Date(Date.now() - GENERATION_STALE_MS);
  const rows = await db
    .select({ model: modelCalls.model })
    .from(modelCalls)
    .where(
      and(inArray(modelCalls.provider, LOCAL_PROVIDERS), gt(modelCalls.startedAt, cutoff)),
    );
  return rows.filter((r) => !coexists(r.model, myModel)).length;
}

/**
 * Unload every RESIDENT Ollama model that isn't `keepModel` or the embedder, so
 * an agent's model isn't co-resident with a big model left over from an earlier
 * chat/report (keep_alive keeps models loaded ~5 min after use — that idle
 * residence is the memory pressure that evicts models). `keep_alive:0` on a bare
 * request unloads immediately (verified: done_reason "unload"). Best-effort and
 * bounded — a failure never blocks the run. Returns the names it unloaded.
 * (Only Ollama exposes resident models + an unload; LM Studio JIT/TTL manages
 * its own, and clearing Ollama frees unified RAM for it either way.)
 */
export async function freeIdleLocalResidents(keepModel: string): Promise<string[]> {
  const unloaded: string[] = [];
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return unloaded;
    const data = (await res.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    for (const m of data.models ?? []) {
      const name = m.name ?? m.model ?? "";
      if (!name || name === keepModel || name.startsWith(EMBED_MODEL_PREFIX)) continue;
      await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      unloaded.push(name);
    }
  } catch {
    /* best-effort — freeing residents must never break a run */
  }
  return unloaded;
}

export interface LocalIdleOptions {
  /** The model this run is about to load — used to tell a swap-forcing call apart
   *  from one already on the same (or the tiny embedder) model. */
  myModel: string;
  /** Cap the wait so a stuck/long call can't starve the agent. */
  maxWaitMs?: number;
  /** Poll cadence while parked. */
  pollMs?: number;
  /** Called on each park with the contender count + elapsed ms — for a heartbeat
   *  write so a waiting run isn't swept as orphaned, and telemetry. */
  onWait?: (busy: number, waitedMs: number) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Block until no OTHER heavy local model is actively generating, so an agent's
 * model load doesn't swap out a model LM Studio / Ollama is mid-call on (the swap
 * evicts a resident model → "Model unloaded" / "terminated" thrash). A call on
 * the SAME model or the tiny embedder is not contention, so this returns
 * immediately in the common case and only parks behind a genuinely conflicting
 * generation — normally clearing the instant that call finishes. Bounded by
 * maxWaitMs so a stuck call never starves the agent. A gate error never blocks
 * the run (returns as idle). Cloud-provider agents should not call this.
 */
export async function waitForLocalIdle(
  opts: LocalIdleOptions,
): Promise<{ waitedMs: number; timedOut: boolean }> {
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 1500;
  const start = Date.now();
  let waited = 0;
  while (true) {
    if (opts.signal?.aborted) return { waitedMs: waited, timedOut: false };
    let busy: number;
    try {
      busy = await activeLocalContenders(opts.myModel);
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
