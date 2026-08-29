/**
 * Apple-MLX provider — served by **LM Studio** (OpenAI-compatible, default
 * `http://localhost:1234/v1`).
 *
 * Why LM Studio rather than a raw `mlx_lm.server`: it runs models on Apple's MLX
 * framework (measured ~1.25–1.5× Ollama's throughput and far better TTFT on the
 * same 35B-A3B model, M4 Pro) AND manages the model lifecycle natively — JIT
 * load on first request, idle-TTL unload — so apOS no longer has to babysit a
 * launchd process to avoid a 17GB model sitting resident. Configure JIT/TTL in
 * LM Studio → Developer.
 *
 * Reasoning: the Qwen3 MoE models default to chain-of-thought, which streams on
 * a separate `reasoning_content` channel and adds seconds of latency before any
 * answer. For a snappy assistant we send `reasoning_effort: "none"` to disable
 * it. (When reasoning is left on, openai-compat surfaces it as `reasoning`
 * events so the UI can show a "thinking…" state instead of dead air.)
 *
 * Local + free (no key), so it's classified `local` (never in CLOUD_PROVIDERS).
 * Point the endpoint at `mlx_base_url` (Settings · Connections) or `MLX_BASE_URL`.
 */
import type { AIProvider } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

async function mlxBase(): Promise<string> {
  const { getSetting } = await import("@/core/app-settings");
  const fromSetting = (await getSetting("mlx_base_url").catch(() => null))?.trim();
  const base = fromSetting || process.env.MLX_BASE_URL || "http://localhost:1234/v1";
  return base.replace(/\/$/, "");
}

export const mlxProvider: AIProvider = {
  id: "mlx",

  async listModels() {
    // Prefer the user-curated list (Settings · Connections · `mlx_models`) — LM
    // Studio JIT-loads any of them on demand by id, so this is what should
    // appear in the routing dropdown. Falls back to whatever LM Studio reports.
    const { getSetting } = await import("@/core/app-settings");
    const configured = (await getSetting("mlx_models").catch(() => null))?.trim();
    if (configured) {
      return configured
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const base = await mlxBase();
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`LM Studio ${base}/models → ${res.status}`);
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  },

  async *run(opts) {
    // LM Studio JIT-loads the model on this request and TTL-unloads it later —
    // no process management here.
    //
    // Reasoning is pure latency for a chat assistant, so we disable it there.
    // But an AGENTIC run (tools present) NEEDS a little planning: the model has
    // to notice it has read enough and then COMMIT its writes. With reasoning
    // fully off, some MLX models (notably the abliterated-35B) loop on reads and
    // never call the write tool. So: light reasoning when tools are present,
    // none for pure chat/text — snappy where it matters, deliberate where it must.
    const base = await mlxBase();
    // Explicit caller hint wins (an interactive path forces "none" to stay
    // snappy); otherwise light reasoning for agentic/tool runs, none for chat.
    const agentic = (opts.tools?.length ?? 0) > 0;
    const reasoning = opts.reasoning ?? (agentic ? "low" : "none");
    // serializeLocal routes each model-generation call through the local queue
    // (shared with Ollama) so a big MLX run doesn't thrash against agents / the
    // embed sweep on the same box — freed during tool execution, so a tool's own
    // local call can't deadlock the run.
    yield* runOpenAICompatible(
      base,
      "lmstudio",
      opts,
      { reasoning_effort: reasoning },
      true,
    );
  },
};
