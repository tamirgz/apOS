import type { AIProvider } from "./provider";
import { runOpenAICompatible } from "./openai-compat";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

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
    return runOpenAICompatible(`${OLLAMA_BASE}/v1`, "ollama", opts, {}, true);
  },
};
