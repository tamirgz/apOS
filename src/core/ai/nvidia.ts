import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AIEvent, AIProvider, AIRunOptions } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

// Free-tier NVIDIA cloud (build.nvidia.com), OpenAI-compatible. Free-only by
// construction: run() refuses any model not confirmed $0 in opencode's pricing
// catalog, fail-closed (missing catalog ⇒ refuse everything), so a periodic
// agent on this provider can never bill — matching the Workbench guard.
const NVIDIA_BASE =
  process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const CATALOG = join(homedir(), ".cache", "opencode", "models.json");

let freeCache: { at: number; ids: Set<string> } | null = null;

/** Model ids priced at $0 (in+out) with tool-calling, from opencode's DB. */
function freeToolModels(): Set<string> {
  if (freeCache && Date.now() - freeCache.at < 60_000) return freeCache.ids;
  const ids = new Set<string>();
  try {
    const doc = JSON.parse(readFileSync(CATALOG, "utf8")) as Record<
      string,
      { models?: Record<string, { cost?: { input?: number; output?: number }; tool_call?: boolean }> }
    >;
    const models = doc.nvidia?.models ?? {};
    for (const [id, m] of Object.entries(models)) {
      const c = m.cost ?? {};
      if ((c.input ?? 0) === 0 && (c.output ?? 0) === 0 && m.tool_call) ids.add(id);
    }
  } catch {
    // fail-closed: no catalog ⇒ empty set ⇒ every model is refused
  }
  freeCache = { at: Date.now(), ids };
  return ids;
}

/** Throws unless the model is a confirmed-free tool-capable NVIDIA model. */
export function assertFreeNvidiaModel(model: string): void {
  if (!freeToolModels().has(model)) {
    throw new Error(
      `refusing NVIDIA model "${model}" — not confirmed free ($0) in the pricing catalog. The agent layer runs free models only.`,
    );
  }
}

export const nvidiaProvider: AIProvider = {
  id: "nvidia",

  async listModels() {
    // Only ever surface the free + tool-capable set (never the paid models).
    return [...freeToolModels()].sort();
  },

  // The agentic loop is the SHARED OpenAI-compatible runner (runaway-loop
  // guard, tool memoization, repeatable-iterator handling included) — this
  // provider only adds the free-model gate and the API key.
  async *run(opts: AIRunOptions): AsyncIterable<AIEvent> {
    try {
      assertFreeNvidiaModel(opts.model); // fail-closed before any network call
    } catch (e) {
      yield { type: "error", message: String(e) };
      return;
    }
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      yield { type: "error", message: "NVIDIA_API_KEY is not set" };
      return;
    }
    yield* runOpenAICompatible(NVIDIA_BASE, apiKey, opts);
  },
};
