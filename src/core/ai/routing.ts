import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { aiRoutes, type AIProviderId } from "@/core/db/schema/ai-routes";
import type { AIEvent, AIProvider, AIRunOptions } from "./provider";
import { anthropicProvider } from "./anthropic";
import { ollamaProvider } from "./ollama";
import { mlxProvider } from "./mlx";
import { nvidiaProvider } from "./nvidia";
import { geminiProvider } from "./gemini";
import { openrouterProvider } from "./openrouter";
import { tokenharborProvider } from "./tokenharbor";
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
  tokenharbor: tracked("tokenharbor", tokenharborProvider),
};

// Re-exported for server-side callers that already import this module —
// the actual definition lives in the schema file so client components can
// use it without pulling in the provider SDKs above (see that file's comment).
export { CLOUD_PROVIDERS, isCloudProvider } from "@/core/db/schema/ai-routes";

/** A route's model target (primary or fallback). */
export interface RouteTarget {
  provider: AIProviderId;
  model: string;
}

/** `ai_routes.options` — today only the editable fallback. */
export interface RouteOptions {
  /** Rerun here when the primary errors before producing output (runTask). */
  fallback?: RouteTarget | null;
}

export interface ResolvedRoute {
  taskKey: string;
  provider: AIProvider;
  providerId: AIProviderId;
  model: string;
  fallback: RouteTarget | null;
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

const DEFAULTS: (RouteTarget & { taskKey: string; options?: RouteOptions })[] = [
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
  { taskKey: "knowledge.enrich", ...CAPABLE, options: { fallback: { provider: "mlx", model: "qwen3-coder-30b-a3b-instruct" } } },
  { taskKey: "inbox.triage", ...LIGHT },
  { taskKey: "ideas.analyze", ...CAPABLE },
  // Ask (cited Q&A over the user's corpus). Escalate to Claude in Settings for
  // deeper synthesis.
  { taskKey: "ask", ...CAPABLE, options: { fallback: { provider: "ollama", model: "qwen3-coder:30b" } } },
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
  { taskKey: "project.advisor", ...LIGHT, options: { fallback: { provider: "ollama", model: "qwen3-coder:30b" } } },
  // Memory learning engine — the weekly distiller that abstracts episodic events
  // into durable facts/policies. LOCAL by policy (memory work never bills), so
  // pinned to explicit local models rather than CAPABLE/LIGHT (which follow the
  // cloud-brain env). Editable in Settings like any other route.
  { taskKey: "memory.distill", provider: "ollama", model: "qwen3-coder:30b" },
  // Insight quality gate — the cheap judge that rejects a generic advisor brief.
  { taskKey: "insight.verify", provider: "ollama", model: "qwen3:8b" },
  // Small local jobs that used to hardcode their model — each is now a route.
  // Area drawers: the qwen tier behind the decision model (below).
  { taskKey: "area.classify", provider: "ollama", model: "qwen3:8b" },
  // The decision model (laya) — first tier of area classify. Ollama-only: it
  // runs on Ollama's /v1/systemone endpoint; another provider disables it.
  { taskKey: "decide", provider: "ollama", model: process.env.AIOS_DECIDE_MODEL ?? "laya:421m-typed-decisions-mlx-fp16" },
  { taskKey: "tasks.shortTitle", provider: "ollama", model: "qwen3:8b" },
  { taskKey: "orbit.namer", provider: "ollama", model: "qwen3:8b" },
  { taskKey: "ask.linkJudge", provider: "ollama", model: process.env.ASK_JUDGE_MODEL || "qwen3:8b" },
  { taskKey: "inbox.verify", provider: "ollama", model: process.env.INBOX_VERIFY_MODEL || "qwen3:8b" },
  { taskKey: "telegram.translate", provider: "ollama", model: "qwen3:8b" },
  // The daily investments report (a Runs task; the provider must be one the
  // Workbench has an executor for).
  { taskKey: "investments.report", provider: "ollama", model: "qwen3-coder:30b" },
];

/** Insert default rows once so the Settings UI always has something to edit.
 *  Read-first: the common case stays a single SELECT. */
export async function ensureDefaultRoutes(): Promise<number> {
  const existing = await db
    .select({ taskKey: aiRoutes.taskKey })
    .from(aiRoutes);
  const have = new Set(existing.map((r) => r.taskKey));
  const missing = DEFAULTS.filter((d) => !have.has(d.taskKey));
  if (missing.length) {
    await db.insert(aiRoutes).values(missing).onConflictDoNothing();
  }
  // Seeded fallbacks reach rows that predate them (options still NULL). A user
  // who clears a fallback stores {} — never NULL — so this never re-adds it.
  for (const d of DEFAULTS) {
    if (!d.options || !have.has(d.taskKey)) continue;
    await db
      .update(aiRoutes)
      .set({ options: d.options })
      .where(and(eq(aiRoutes.taskKey, d.taskKey), isNull(aiRoutes.options)));
  }
  return missing.length;
}

function fallbackOf(options: unknown): RouteTarget | null {
  const fb = (options as RouteOptions | null)?.fallback;
  return fb?.provider && fb.model ? fb : null;
}

/**
 * Exact key → that key's own seed → "agent.default" → "chat" → local-first hard
 * default. One query. The seed step keeps a known task on its intended (local)
 * model before Settings has seeded it, instead of inheriting agent.default.
 */
export async function resolveRoute(taskKey: string): Promise<ResolvedRoute> {
  const keys =
    taskKey === "chat" ? ["chat"] : [taskKey, "agent.default", "chat"];
  const rows = await db
    .select()
    .from(aiRoutes)
    .where(inArray(aiRoutes.taskKey, keys));
  const byKey = new Map(rows.map((r) => [r.taskKey, r]));
  const seed = DEFAULTS.find((d) => d.taskKey === taskKey);
  for (const key of keys) {
    const row = byKey.get(key);
    if (row) {
      return {
        taskKey,
        provider: providers[row.provider],
        providerId: row.provider,
        model: row.model,
        fallback: fallbackOf(row.options),
      };
    }
    if (key === taskKey && seed) {
      return {
        taskKey,
        provider: providers[seed.provider],
        providerId: seed.provider,
        model: seed.model,
        fallback: seed.options?.fallback ?? null,
      };
    }
  }
  // No row at all (routes not seeded yet): the same local-first tier the seeds
  // use — never a metered model by default.
  return {
    taskKey,
    provider: providers[CAPABLE.provider],
    providerId: CAPABLE.provider,
    model: CAPABLE.model,
    fallback: null,
  };
}

/**
 * Run a routed task with automatic fallback. Yields the primary run's events;
 * if the primary errors BEFORE producing any output (a free-tier allowance
 * exhausted → 429, or the provider unreachable), it transparently reruns on the
 * route's fallback (`options.fallback`, editable in Settings → AI Routing). A primary that already streamed output is NOT re-run (no double
 * answer / double tool-write) — its error is surfaced as-is.
 */
export async function* runTask(
  taskKey: string,
  opts: Omit<AIRunOptions, "model">,
): AsyncIterable<AIEvent> {
  const route = await resolveRoute(taskKey);
  const fb = route.fallback;
  let produced = false;
  let failed = false;
  const isOutput = (t: AIEvent["type"]) =>
    t === "text" || t === "tool_call" || t === "tool_result" || t === "done";
  try {
    for await (const ev of route.provider.run({ ...opts, model: route.model })) {
      if (ev.type === "error") {
        failed = true;
        if (produced) yield ev; // partial output already streamed — surface it
        break;
      }
      if (isOutput(ev.type)) produced = true;
      yield ev;
    }
  } catch (e) {
    failed = true;
    if (produced) yield { type: "error", message: String(e) };
  }
  if (
    failed &&
    !produced &&
    fb &&
    !(fb.provider === route.providerId && fb.model === route.model)
  ) {
    for await (const ev of providers[fb.provider].run({ ...opts, model: fb.model })) {
      yield ev;
    }
  }
}

/**
 * One-shot text completion on a routed task — no tools, one turn, reasoning off.
 * The shared idiom for gates, judges and small rewrite jobs, so their model is a
 * Settings route rather than a constant. Runs through runTask, so the route's
 * fallback applies. Throws on a provider error; think-blocks are stripped.
 */
export async function completeText(
  taskKey: string,
  input: { system: string; user: string; label: string; source?: string; temperature?: number; signal?: AbortSignal },
): Promise<string> {
  let out = "";
  for await (const ev of runTask(taskKey, {
    system: input.system,
    messages: [{ role: "user", content: input.user }],
    tools: [],
    toolCtx: { db },
    maxTurns: 1,
    reasoning: "none",
    temperature: input.temperature ?? 0,
    signal: input.signal,
    track: { source: input.source ?? "job", label: input.label, taskKey },
  })) {
    if (ev.type === "text") out += ev.text;
    else if (ev.type === "done" && ev.text) out = ev.text;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** `fallback` undefined = leave the stored one; null = clear it. */
export async function setRoute(
  taskKey: string,
  provider: AIProviderId,
  model: string,
  fallback?: RouteTarget | null,
) {
  const options = fallback === undefined ? {} : { options: { fallback } };
  await db
    .insert(aiRoutes)
    .values({ taskKey, provider, model, updatedAt: new Date(), ...options })
    .onConflictDoUpdate({
      target: aiRoutes.taskKey,
      set: { provider, model, updatedAt: new Date(), ...options },
    });
  // Let the worker hot-reload its routing without polling.
  await sql.notify("config_changed", taskKey);
}
