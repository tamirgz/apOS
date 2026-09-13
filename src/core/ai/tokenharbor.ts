import { getSetting } from "@/core/app-settings";
import type { AIEvent, AIProvider, AIRunOptions } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

/**
 * Token Harbor (https://tokenharbor.ai) via its OpenAI-compatible endpoint — a
 * unified gateway to GPT / Claude / Gemini / DeepSeek / Kimi and more behind one
 * key, like OpenRouter. User-keyed (a Token Harbor key pasted into Settings →
 * Connections, stored in app_settings), with a FREE tier (model ids ending
 * `:free`, e.g. deepseek-v4-flash:free, mimo-v2.5:free) — added so its free
 * models can be routed and compared against the others in AI Routing / Usage.
 *
 * Key read from app_settings first, then TOKENHARBOR_API_KEY. That env var is
 * NOT in METERED_AUTH_VARS (see core/ai/auth.ts), so it is not stripped at
 * startup and can be wired through `.env.local`.
 */
const TOKENHARBOR_BASE =
  process.env.TOKENHARBOR_BASE_URL ?? "https://tokenharbor.ai/v1";

/** Shown if the live model list can't be fetched (no key yet, or offline). The
 *  free tier rotates, so /models is the real source of truth. */
const FALLBACK_MODELS = [
  "deepseek-v4.1-flash:free",
  "deepseek-v4-flash:free",
  "mimo-v2.5:free",
];

async function apiKey(): Promise<string> {
  const key =
    (await getSetting("tokenharbor_api_key"))?.trim() ||
    process.env.TOKENHARBOR_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Token Harbor API key not set — add it in Settings → Connections (tokenharbor.ai)",
    );
  }
  return key;
}

interface THModel {
  id: string;
  supported_parameters?: string[];
}

export const tokenharborProvider: AIProvider = {
  id: "tokenharbor",

  async listModels() {
    try {
      const key =
        (await getSetting("tokenharbor_api_key").catch(() => null))?.trim() ||
        process.env.TOKENHARBOR_API_KEY?.trim();
      const res = await fetch(`${TOKENHARBOR_BASE}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return FALLBACK_MODELS;
      const data = (await res.json()) as { data?: THModel[] };
      const models = (data.data ?? []).map((m) => ({
        id: m.id,
        tools: !!m.supported_parameters?.includes("tools"),
        free: m.id.endsWith(":free"),
      }));
      // Free first (they're the point right now), tool-capable first within a
      // tier, then by id.
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
    yield* runOpenAICompatible(TOKENHARBOR_BASE, key, opts);
  },
};
