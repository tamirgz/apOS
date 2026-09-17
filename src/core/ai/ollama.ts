import type { AIEvent, AIProvider } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

// After a BACKGROUND generation (an agent, gate, job, flow, sweep — anything not
// a live user surface), reset that model's keep-alive to this short TTL so it
// self-evicts soon instead of lingering Ollama's 5-min default and stacking up
// with the next model. Interactive surfaces (chat/ask) keep the default so a
// follow-up stays warm. Env-tunable. NOTE: keep_alive is silently ignored on the
// OpenAI-compat /v1 endpoint the run uses, so it must be set via a bare native
// /api/generate request after the call — done here.
const BG_KEEP_ALIVE = process.env.AIOS_LOCAL_BG_KEEP_ALIVE ?? "60s";
// Live user surfaces keep the model warm for snappy follow-ups.
const INTERACTIVE_KEEP_ALIVE = process.env.AIOS_LOCAL_KEEP_ALIVE ?? "5m";
const INTERACTIVE_SOURCES = new Set(["chat", "ask"]);

async function setKeepAlive(model: string, keepAlive: string) {
  try {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: keepAlive }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* best-effort — TTL housekeeping must never affect the run */
  }
}

/**
 * Stream the shared run, then set the model's keep-alive EXPLICITLY — short for
 * background work (an agent/gate/job/sweep evicts ~1 min after finishing instead
 * of squatting Ollama's 5-min default and stacking with the next model), longer
 * for live surfaces (chat/ask stay warm). Set on both paths because a bare /v1
 * request carries no keep_alive and Ollama then LEAVES the current timer as-is —
 * so an interactive call after a background one would otherwise inherit the short
 * TTL. The bare native request only re-arms the timer on the already-resident
 * model; it neither reloads it nor blocks the run.
 */
async function* withKeepAlive(
  model: string,
  keepAlive: string,
  gen: AsyncIterable<AIEvent>,
): AsyncIterable<AIEvent> {
  try {
    yield* gen;
  } finally {
    await setKeepAlive(model, keepAlive);
  }
}

export const ollamaProvider: AIProvider = {
  id: "ollama",

  async listModels() {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`ollama /api/tags → ${res.status}`);
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  },

  // The streaming + tool loop is shared with the mlx provider. `serializeLocal`
  // routes each model-generation call through the local-inference queue so
  // concurrent runs don't thrash the machine (freed during tool execution, so a
  // tool's own local call can't deadlock the run).
  run(opts) {
    const gen = runOpenAICompatible(`${OLLAMA_BASE}/v1`, "ollama", opts, {}, true);
    const source = opts.track?.source ?? "unknown";
    const ttl = INTERACTIVE_SOURCES.has(source)
      ? INTERACTIVE_KEEP_ALIVE
      : BG_KEEP_ALIVE;
    return withKeepAlive(opts.model, ttl, gen);
  },
};
