"use client";

import { useState, useTransition } from "react";
import { Check, Info } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useProviderModels } from "@/core/ui/useProviderModels";
import type { AiRoute, AIProviderId } from "@/core/db/schema/ai-routes";
import { AI_PROVIDERS } from "@/core/db/schema/ai-routes";
import { saveRoute } from "../actions";

const KEY_LABELS: Record<string, string> = {
  chat: "⌘K chat & commands",
  "chat.investments": "Investments page chat (needs faithful tool-data threading)",
  "agent.default": "Agents (default, no per-agent override)",
  "knowledge.enrich": "Knowledge enrichment",
  "inbox.triage": "Inbox triage",
  "ideas.analyze": "Idea reality-check",
  ask: "Ask (cited Q&A)",
  "project.advisor": "Project advisor (per-project read + re-angle)",
  "workbench.native": "Runs · docs tasks (apOS data + module tools)",
  "workbench.judge": "Runs · delegation judge — PRIMARY (local-first)",
  "workbench.judge.fallback": "Runs · delegation judge — FALLBACK (online, only if local is down)",
  "routine.builder": "Routines · builder (composes a routine from your description)",
  "source.relevance": "Sources · relevance gate (is this post worth a run?)",
  "routine.gate": "Routines · commit gate (does this commit need the executor?)",
  "memory.distill": "Memory · learning engine (distills events → rules; local)",
  "insight.verify": "Insight quality gate (rejects a generic advisor brief; local)",
};

function RouteRow({ route }: { route: AiRoute }) {
  const [provider, setProvider] = useState<AIProviderId>(route.provider);
  const [model, setModel] = useState(route.model);
  const [pending, startTransition] = useTransition();
  const [savedTick, setSavedTick] = useState(false);
  const { models, error: loadError } = useProviderModels(provider);

  const dirty = provider !== route.provider || model !== route.model;

  return (
    <div className="glass flex flex-wrap items-center gap-2.5 rounded-xl p-3">
      <div className="min-w-40">
        <p className="text-sm text-ink">
          {KEY_LABELS[route.taskKey] ?? route.taskKey}
        </p>
        <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
          {route.taskKey}
        </p>
      </div>

      <select
        value={provider}
        onChange={(e) => {
          const p = e.target.value as AIProviderId;
          setProvider(p);
          setModel("");
        }}
        className="h-9 rounded-lg border border-white/10 bg-abyss px-3 font-mono text-xs text-ink outline-none focus:border-plasma/40"
      >
        {AI_PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="h-9 min-w-56 flex-1 rounded-lg border border-white/10 bg-abyss px-3 font-mono text-xs text-ink outline-none focus:border-plasma/40"
      >
        {model && !models.includes(model) && (
          <option value={model}>{model}</option>
        )}
        <option value="" disabled>
          {models.length ? "select model…" : "loading models…"}
        </option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <button
        type="button"
        disabled={!dirty || !model || pending}
        onClick={() =>
          startTransition(async () => {
            await saveRoute(route.taskKey, provider, model);
            setSavedTick(true);
            setTimeout(() => setSavedTick(false), 1600);
          })
        }
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-lg px-4 font-mono text-[11px] uppercase tracking-widest transition",
          dirty
            ? "bg-plasma/15 text-plasma hover:bg-plasma/25"
            : "border border-white/8 text-ink-faint",
          pending && "opacity-50",
        )}
      >
        {savedTick ? <Check className="size-3.5" /> : null}
        {pending ? "saving…" : savedTick ? "saved" : "save"}
      </button>

      {loadError && (
        <p className="w-full font-mono text-[10px] text-flare">
          model list unavailable: {loadError.slice(0, 120)}
        </p>
      )}
    </div>
  );
}

export function RoutesEditor({ routes }: { routes: AiRoute[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          ai routing — which brain answers which job
        </p>
        <span
          className="cursor-help text-ink-faint/70 transition hover:text-ink-dim"
          title={
            "These are no-API-key, in-process brains that run apOS's own tools: " +
            "Claude (Max subscription), Ollama (local, free), NVIDIA (free tier), " +
            "or Gemini (your metered AI Studio key). " +
            "OpenAI/GPT-5 isn't listed here because its no-key subscription path is " +
            "CLI-only (Codex) and can't host apOS's module tools — so GPT-5 lives in " +
            'Runs as the "Codex (GPT-5, ChatGPT sub)" executor, not in this dropdown.'
          }
        >
          <Info className="size-3" />
        </span>
      </div>
      {routes.map((r) => (
        <RouteRow key={r.taskKey} route={r} />
      ))}
    </div>
  );
}
