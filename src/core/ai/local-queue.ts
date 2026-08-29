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
