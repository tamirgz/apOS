import { getSetting } from "@/core/app-settings";
import type { AIEvent, AIProvider, AIRunOptions } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

/**
 * OpenRouter via its OpenAI-compatible endpoint. Like gemini this is a
 * user-keyed cloud provider (an OpenRouter key pasted into Settings →
 * Connections, stored in app_settings), NOT a subscription/local provider — but
 * OpenRouter carries a large **free tier** (model ids ending `:free`), which is
 * exactly what the installer's low-spec "cloud-brain" mode routes reasoning to
 * while embeddings stay local on Ollama.
 *
 * The key is read from app_settings first, then the OPENROUTER_API_KEY env var.
 * That env var is deliberately NOT in METERED_AUTH_VARS (see core/ai/auth.ts),
 * so — unlike OPENAI_API_KEY — it is not stripped at startup and the installer
 * can wire it through `.env.local`.
 */
const OPENROUTER_BASE =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** Shown if the live model list can't be fetched (no key yet, or offline).
 *  Known tool-capable free models — agents need tool-calling. Free models
 *  rotate, so the live list from /models is the real source of truth. */
const FALLBACK_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
];

async function apiKey(): Promise<string> {
  const key =
    (await getSetting("openrouter_api_key"))?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OpenRouter API key not set — add it in Settings → Connections (openrouter.ai/keys)",
    );
  }
  return key;
}

interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
}

export const openrouterProvider: AIProvider = {
  id: "openrouter",

  async listModels() {
    try {
      // OpenRouter's /models is PUBLIC — list the full catalogue even before a
      // key is set (a key is only needed to RUN a model). Without this, no key
      // meant falling back to 4 hardcoded ids while the live tier has dozens.
      const key =
        (await getSetting("openrouter_api_key").catch(() => null))?.trim() ||
        process.env.OPENROUTER_API_KEY?.trim();
      const res = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return FALLBACK_MODELS;
      const data = (await res.json()) as { data?: OpenRouterModel[] };
      // Present EVERY model — the whole free tier, not just the tool-capable
      // subset (chat / Ask need no tools). We only ORDER by usefulness: free
      // before paid, and within each tier tool-capable first (agents need tools,
      // so the sensible agent picks stay at the top) — then sorted by id.
      const models = (data.data ?? []).map((m) => ({
        id: m.id,
        tools: !!m.supported_parameters?.includes("tools"),
        free: m.id.endsWith(":free"),
      }));
      const tier = (free: boolean) => {
        const g = models.filter((m) => m.free === free);
        return [
          ...g.filter((m) => m.tools).map((m) => m.id).sort(),
          ...g.filter((m) => !m.tools).map((m) => m.id).sort(),
        ];
      };
      const ordered = [...tier(true), ...tier(false)];
      return ordered.length ? ordered : FALLBACK_MODELS;
    } catch {
      // No key yet or the list call failed — offer the known-good free defaults
      // so the picker still works; run() surfaces the real "key not set" error.
      return FALLBACK_MODELS;
    }
  },

  async *run(opts: AIRunOptions): AsyncIterable<AIEvent> {
    let key: string;
    try {
      key = await apiKey();
    } catch (e) {
      yield { type: "error", message: String(e) };
      return;
    }
    yield* runOpenAICompatible(OPENROUTER_BASE, key, opts);
  },
};
