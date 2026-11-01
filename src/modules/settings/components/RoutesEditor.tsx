"use client";

import { useState, useTransition } from "react";
import { Check, Info } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
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
  "agent.subtask": "Agents · sub-task (fresh-context investigation an agent spawns)",
  "area.classify": "Search · area drawers (files items into life areas)",
  decide: "Search · decision model (fast first tier of area drawers; Ollama only)",
  "tasks.shortTitle": "Tracker · short titles for long item titles",
  "orbit.namer": "Orbit · names the topic clusters",
  "ask.linkJudge": "Ask · related-link judge",
  "inbox.verify": "Inbox · capture verifier (is this really a task?)",
  "telegram.translate": "Telegram · translates foreign posts for search",
  "investments.report": "Investments · daily report (Runs task)",
};

const SELECT =
  "h-9 rounded-lg border border-white/10 bg-abyss px-3 font-mono text-xs text-ink outline-none focus:border-plasma/40";

/** A model <select> fed by the provider's live model list; keeps a saved model
 *  visible even when the list doesn't (yet) include it. */
function ModelSelect({
  provider,
  value,
  onChange,
  className,
}: {
  provider: AIProviderId | "";
  value: string;
  onChange: (m: string) => void;
  className?: string;
}) {
  const { models, error } = useProviderModels(provider);
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cn(SELECT, className)}>
        {value && !models.includes(value) && <option value={value}>{value}</option>}
        <option value="" disabled>
          {models.length ? "select model…" : "loading models…"}
        </option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      {error && (
        <p className="w-full font-mono text-[10px] text-flare">
          model list unavailable: {error.slice(0, 120)}
        </p>
      )}
    </>
  );
}

function fallbackOf(route: AiRoute): { provider: AIProviderId; model: string } | null {
  const fb = (route.options as { fallback?: { provider: AIProviderId; model: string } | null } | null)?.fallback;
  return fb?.provider && fb.model ? fb : null;
}

function RouteRow({ route }: { route: AiRoute }) {
  const [provider, setProvider] = useState<AIProviderId>(route.provider);
  const [model, setModel] = useState(route.model);
  const savedFb = fallbackOf(route);
  const [fbProvider, setFbProvider] = useState<AIProviderId | "">(savedFb?.provider ?? "");
  const [fbModel, setFbModel] = useState(savedFb?.model ?? "");
  const [pending, startTransition] = useTransition();
  const [savedTick, setSavedTick] = useState(false);

  const fallback = fbProvider ? { provider: fbProvider, model: fbModel } : null;
  const dirty =
    provider !== route.provider ||
    model !== route.model ||
    (savedFb?.provider ?? "") !== fbProvider ||
    (savedFb?.model ?? "") !== (fbProvider ? fbModel : "");

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
        className={SELECT}
      >
        {AI_PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <ModelSelect provider={provider} value={model} onChange={setModel} className="min-w-56 flex-1" />

      <button
        type="button"
        disabled={!dirty || !model || (!!fallback && !fallback.model) || pending}
        onClick={() =>
          startTransition(async () => {
            const r = await act(() => saveRoute(route.taskKey, provider, model, fallback), { failed: "Couldn't save the route" });
            if (!r.ok) return;
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

      <div className="flex w-full flex-wrap items-center gap-2.5">
        <span
          className="cursor-help font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint"
          title="Used only when the primary fails before answering (e.g. a free tier is exhausted or the server is down)."
        >
          fallback
        </span>
        <select
          value={fbProvider}
          onChange={(e) => {
            setFbProvider(e.target.value as AIProviderId | "");
            setFbModel("");
          }}
          className={SELECT}
        >
          <option value="">none</option>
          {AI_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {fbProvider && (
          <ModelSelect provider={fbProvider} value={fbModel} onChange={setFbModel} className="min-w-56 flex-1" />
        )}
      </div>
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
