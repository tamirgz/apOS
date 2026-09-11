import { inArray } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { aiRoutes, type AIProviderId } from "@/core/db/schema/ai-routes";
import type { AIProvider } from "./provider";
import { anthropicProvider } from "./anthropic";
import { ollamaProvider } from "./ollama";
import { mlxProvider } from "./mlx";
import { nvidiaProvider } from "./nvidia";
import { geminiProvider } from "./gemini";
import { openrouterProvider } from "./openrouter";
import { trackGeneration } from "./model-track";

/**
 * Wrap a provider so EVERY run() registers a live row in the model-call queue
 * for the duration of the call. This is the single chokepoint: whatever calls
 * resolveRoute().provider.run(...) or providers.<id>.run(...) is tracked, so no
 * model invocation can escape the queue.
 */
function tracked(id: AIProviderId, p: AIProvider): AIProvider {
  return {
    ...p,
    run: (opts) => trackGeneration(id, opts.model, opts.track, p.run(opts)),
  };
}

export const providers: Record<AIProviderId, AIProvider> = {
  anthropic: tracked("anthropic", anthropicProvider),
  ollama: tracked("ollama", ollamaProvider),
  mlx: tracked("mlx", mlxProvider),
  nvidia: tracked("nvidia", nvidiaProvider),
  gemini: tracked("gemini", geminiProvider),
  openrouter: tracked("openrouter", openrouterProvider),
};

// Re-exported for server-side callers that already import this module —
// the actual definition lives in the schema file so client components can
// use it without pulling in the provider SDKs above (see that file's comment).
export { CLOUD_PROVIDERS, isCloudProvider } from "@/core/db/schema/ai-routes";

export interface ResolvedRoute {
  taskKey: string;
  provider: AIProvider;
  providerId: AIProviderId;
  model: string;
}

// LOCAL-FIRST defaults: a fresh install runs entirely on Ollama (free, no
// account). Two model tiers are used — `qwen3-coder:30b` for capable work
// (chat, ask, enrichment, judging) and `qwen3:8b` for the light, high-frequency
// gates. Connecting Claude is an OPT-IN: the user re-routes any task to the
// `anthropic` provider in Settings → AI Routing. These seeds only fill MISSING
// rows (`ensureDefaultRoutes`), so they never override a user's choices.
// (Tiering: a "Lite" install may only have qwen3:8b — route resolution should
// fall back to an available local model; see the distribution plan.)
//
// CLOUD-BRAIN (low-spec machines): when the installer detects a machine that
// can't comfortably run a local chat model, it sets AIOS_DEFAULT_BRAIN=openrouter
// (+ an optional AIOS_DEFAULT_MODEL and the OPENROUTER_API_KEY) in .env.local.
// The reasoning tasks below then seed to OpenRouter's free tier instead of
// Ollama, while EMBEDDINGS stay local (nomic-embed-text runs on any machine).
// Unset (the normal case) → everything stays local-first on Ollama. These seeds
// only fill MISSING rows, so a user can still re-route anything in Settings.
const CLOUD_BRAIN = process.env.AIOS_DEFAULT_BRAIN === "openrouter";
const CLOUD_MODEL =
  process.env.AIOS_DEFAULT_MODEL?.trim() ||
  "meta-llama/llama-3.3-70b-instruct:free";
// "Capable" = the heavier reasoning tier; "light" = high-frequency gates.
const CAPABLE: { provider: AIProviderId; model: string } = CLOUD_BRAIN
  ? { provider: "openrouter", model: CLOUD_MODEL }
  : { provider: "ollama", model: "qwen3-coder:30b" };
const LIGHT: { provider: AIProviderId; model: string } = CLOUD_BRAIN
  ? { provider: "openrouter", model: CLOUD_MODEL }
  : { provider: "ollama", model: "qwen3:8b" };

const DEFAULTS: { taskKey: string; provider: AIProviderId; model: string }[] = [
  { taskKey: "chat", ...CAPABLE },
  // Investments-page chat: needs a model that faithfully threads tool data into
  // its charts/analysis (the fast coder-instruct fabricates). Seeded to the
  // capable local default; editable in Settings (this user runs it on the MLX
  // abliterated with light reasoning).
  { taskKey: "chat.investments", ...CAPABLE },
  { taskKey: "agent.default", ...CAPABLE },
  // Hierarchical sub-agent (agent.subtask): a fresh-context sub-run an agent
  // spawns to investigate one item without bloating its own context. Pinned to
  // an explicit LOCAL model so a free periodic agent (e.g. Project pulse) that
  // fans out never starts billing — same free-by-policy stance as memory work.
  // Escalate in Settings → AI Routing if you want deeper sub-agent reasoning.
  { taskKey: "agent.subtask", provider: "ollama", model: "qwen3-coder:30b" },
  { taskKey: "knowledge.enrich", ...CAPABLE },
  { taskKey: "inbox.triage", ...LIGHT },
  { taskKey: "ideas.analyze", ...CAPABLE },
  // Ask (cited Q&A over the user's corpus). Escalate to Claude in Settings for
  // deeper synthesis.
  { taskKey: "ask", ...CAPABLE },
  // Every key below is seeded so it shows up in Settings → AI Routing.
  //
  // Workbench "docs"/native tasks (apOS's own data + module tools).
  { taskKey: "workbench.native", ...CAPABLE },
  // The verifying judge that gates delegated work: reads the ask + the produced
  // result and decides whether the result satisfies the ask (A2 · Trust). Local
  // so verification is free and never depends on a rate-limited cloud plan; the
  // fallback below covers the primary being down. Both editable in Settings.
  { taskKey: "workbench.judge", ...CAPABLE },
  // Safety-net judge — used ONLY when the primary can't run. A lighter model by
  // default; point it at Claude in Settings if you've connected it.
  { taskKey: "workbench.judge.fallback", ...LIGHT },
  // The routine BUILDER — composes a routine from a plain-English description.
  // Runs ONCE per routine at create time. Settings only — never on the card.
  { taskKey: "routine.builder", ...LIGHT },
  // The source relevance gate: cheaply decides whether an incoming item is worth
  // an expensive routine run. Runs on every post. Configurable.
  { taskKey: "source.relevance", ...LIGHT },
  // The COMMIT relevance gate: on a commit trigger, cheaply decides whether the
  // change touches anything a routine documents before spending the executor.
  { taskKey: "routine.gate", ...LIGHT },
  // Per-project advisor read + the on-demand "different angle" re-read.
  { taskKey: "project.advisor", ...LIGHT },
  // Memory learning engine — the weekly distiller that abstracts episodic events
  // into durable facts/policies. LOCAL by policy (memory work never bills), so
  // pinned to explicit local models rather than CAPABLE/LIGHT (which follow the
  // cloud-brain env). Editable in Settings like any other route.
  { taskKey: "memory.distill", provider: "ollama", model: "qwen3-coder:30b" },
  // Insight quality gate — the cheap judge that rejects a generic advisor brief.
  { taskKey: "insight.verify", provider: "ollama", model: "qwen3:8b" },
];

/** Insert default rows once so the Settings UI always has something to edit.
 *  Read-first: the common case stays a single SELECT. */
export async function ensureDefaultRoutes() {
  const existing = await db
    .select({ taskKey: aiRoutes.taskKey })
    .from(aiRoutes);
  const have = new Set(existing.map((r) => r.taskKey));
  const missing = DEFAULTS.filter((d) => !have.has(d.taskKey));
  if (missing.length) {
    await db.insert(aiRoutes).values(missing).onConflictDoNothing();
  }
}

/** Exact key → "agent.default" → "chat" → hard default. One query. */
export async function resolveRoute(taskKey: string): Promise<ResolvedRoute> {
  const keys =
    taskKey === "chat" ? ["chat"] : [taskKey, "agent.default", "chat"];
  const rows = await db
    .select()
    .from(aiRoutes)
    .where(inArray(aiRoutes.taskKey, keys));
  const byKey = new Map(rows.map((r) => [r.taskKey, r]));
  for (const key of keys) {
    const row = byKey.get(key);
    if (row) {
      return {
        taskKey,
        provider: providers[row.provider],
        providerId: row.provider,
        model: row.model,
      };
    }
  }
  return {
    taskKey,
    provider: providers.anthropic,
    providerId: "anthropic",
    model: "claude-sonnet-5",
  };
}

export async function setRoute(
  taskKey: string,
  provider: AIProviderId,
  model: string,
) {
  await db
    .insert(aiRoutes)
    .values({ taskKey, provider, model, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiRoutes.taskKey,
      set: { provider, model, updatedAt: new Date() },
    });
  // Let the worker hot-reload its routing without polling.
  await sql.notify("config_changed", taskKey);
}
