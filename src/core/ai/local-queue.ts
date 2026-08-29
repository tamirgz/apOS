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

/** Wrap an async generator so it holds a slot for its whole streaming lifetime —
 *  a chat/tool run occupies the model until the stream ends. */
export async function* withLocalSlotGen<T>(
  gen: () => AsyncIterable<T>,
): AsyncIterable<T> {
  await acquire();
  try {
    yield* gen();
  } finally {
    release();
  }
}
