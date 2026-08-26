/**
 * Per-executor setup for the local coding agents whose Ollama wiring needs more
 * than the shared cli plumbing — Qwen Code and Factory Droid. Both talk to the
 * host Ollama through an OpenAI-compatible endpoint; each just needs it supplied
 * differently:
 *
 *   • Qwen Code — env only. It auto-selects its OpenAI auth from OPENAI_API_KEY,
 *     even in a fresh sandbox HOME, so no config file is provisioned.
 *   • Factory Droid — a BYOK "custom model" in `$HOME/.factory/config.json`
 *     (Droid reads it from $HOME, which is the sandbox home). The display name
 *     "aios-ollama" deterministically becomes the model id "custom:aios-ollama-0",
 *     used verbatim in the executor's command template.
 *
 * Called by the engine for cli attempts; a no-op for every other executor.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OLLAMA_V1 = "http://localhost:11434/v1";

/** Strip a provider namespace ("ollama/qwen3.5:…" → "qwen3.5:…") — these tools
 *  take a bare Ollama tag, while apOS stores the namespaced free-model spec. */
function bareModel(model: string | null | undefined): string {
  const s = (model ?? "").trim();
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Extra env for the spawned agent; writes any config it needs into the sandbox
 * HOME first. Returns `{}` for executors that need nothing special.
 */
export function setupLocalAgent(
  executorId: string,
  opts: { runModel: string | null | undefined; home: string },
): Record<string, string> {
  const model = bareModel(opts.runModel);

  if (executorId === "qwen") {
    // Qwen reaches Ollama via its OpenAI-compatible provider. The vars can't be
    // passed in the process env — the harness's subscriptionEnv strips
    // OPENAI_API_KEY/OPENAI_BASE_URL as metered-auth guards — so write them to
    // `$HOME/.qwen/.env`, which Qwen loads itself and the strip can't touch.
    const dir = join(opts.home, ".qwen");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".env"),
        `OPENAI_BASE_URL=${OLLAMA_V1}\nOPENAI_API_KEY=ollama\nOPENAI_MODEL=${model}\n`,
      );
    } catch {
      // Missing config → Qwen fails loudly with "no auth type", not silently.
    }
    return { QWEN_CODE_SUPPRESS_YOLO_WARNING: "1" };
  }

  if (executorId === "droid") {
    const dir = join(opts.home, ".factory");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          custom_models: [
            {
              model_display_name: "aios-ollama",
              model,
              base_url: OLLAMA_V1,
              api_key: "ollama",
              provider: "generic-chat-completion-api",
              max_tokens: 8192,
            },
          ],
        }),
      );
    } catch {
      // If the config can't be written the run will fail loudly with Droid's own
      // "invalid model" — better than silently pointing at the wrong model.
    }
    return {};
  }

  return {};
}
