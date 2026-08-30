import OpenAI from "openai";
import { getSetting } from "@/core/app-settings";
import type { AIEvent, AIProvider, AIRunOptions } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

/**
 * Google Gemini via its OpenAI-compatible endpoint. Unlike ollama/nvidia (free,
 * guarded) this is a **metered** provider: it uses a Google AI Studio API key
 * the user pastes into Settings → Integrations (stored in app_settings, read at
 * call time — never from the environment, which subscriptionEnv strips). A
 * deliberate opt-in exception to the "subscription/local only" rule, so there is
 * no free-model guard here.
 */
const GEMINI_BASE =
  process.env.GEMINI_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1beta/openai/";

/** Shown if the live model list can't be fetched (no key yet, or offline). */
const FALLBACK_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

async function apiKey(): Promise<string> {
  const key = (await getSetting("gemini_api_key"))?.trim();
  if (!key) {
    throw new Error(
      "Gemini API key not set — add it in Settings → Integrations (Google AI Studio key)",
    );
  }
  return key;
}

async function client(): Promise<OpenAI> {
  return new OpenAI({ baseURL: GEMINI_BASE, apiKey: await apiKey() });
}

export const geminiProvider: AIProvider = {
  id: "gemini",

  async listModels() {
    try {
      const openai = await client();
      const res = await openai.models.list();
      const ids = res.data
        .map((m) => m.id.replace(/^models\//, ""))
        .filter((id) => id.startsWith("gemini"));
      return ids.length ? ids.sort() : FALLBACK_MODELS;
    } catch {
      // No key yet or the list call failed — offer the known-good defaults so
      // the picker still works; run() surfaces the real "key not set" error.
      return FALLBACK_MODELS;
    }
  },

  // The agentic loop is the SHARED OpenAI-compatible runner (runaway-loop
  // guard, tool memoization, repeatable-iterator handling included) — this
  // provider only resolves the Settings-stored API key.
  async *run(opts: AIRunOptions): AsyncIterable<AIEvent> {
    let key: string;
    try {
      key = await apiKey();
    } catch (e) {
      yield { type: "error", message: String(e) };
      return;
    }
    yield* runOpenAICompatible(GEMINI_BASE, key, opts);
  },
};
