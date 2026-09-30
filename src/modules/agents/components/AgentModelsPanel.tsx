"use client";

import { useState, useTransition } from "react";
import { Check, Clock } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useProviderModels } from "@/core/ui/useProviderModels";
import {
  AI_PROVIDERS,
  isCloudProvider,
  type AIProviderId,
} from "@/core/db/schema/ai-routes";
import { updateAgent } from "../actions";

export interface AgentModelRow {
  id: string;
  name: string;
  schedule: string | null;
  enabled: boolean;
  provider: AIProviderId | null;
  model: string | null;
}

/** "" = inherit the agent.default route rather than pin a provider. */
const INHERIT = "";

function AgentRow({ agent }: { agent: AgentModelRow }) {
  const [provider, setProvider] = useState<AIProviderId | "">(
    agent.provider ?? INHERIT,
  );
  const [model, setModel] = useState(agent.model ?? "");
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const { models } = useProviderModels(provider);

  const dirty =
    (provider || null) !== (agent.provider ?? null) ||
    (model || null) !== (agent.model ?? null);

  return (
    <div className="glass flex flex-wrap items-center gap-2 rounded-xl p-2.5">
      <div className="min-w-44 flex-1">
        <p className="text-sm text-ink">{agent.name}</p>
        <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          {agent.schedule ? (
            <>
              <Clock className="size-2.5" />
              {agent.schedule}
            </>
          ) : (
            "manual"
          )}
          {!agent.enabled && <span className="text-flare">· disabled</span>}
          {provider && (
            <span className={isCloudProvider(provider) ? "text-solar" : "text-plasma"}>
              · {isCloudProvider(provider) ? "cloud" : "local · free"}
            </span>
          )}
        </p>
      </div>

      <select
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value as AIProviderId | "");
          setModel("");
          setSaved(false);
        }}
        className="h-8 rounded-lg border border-white/10 bg-abyss px-2 font-mono text-[11px] text-ink outline-none focus:border-plasma/40"
      >
        <option value={INHERIT}>route default</option>
        {AI_PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
          setSaved(false);
        }}
        disabled={!provider}
        className="h-8 w-56 rounded-lg border border-white/10 bg-abyss px-2 font-mono text-[11px] text-ink outline-none focus:border-plasma/40 disabled:opacity-40"
      >
        {model && !models.includes(model) && <option value={model}>{model}</option>}
        <option value="">{provider ? "select model…" : "—"}</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <button
        type="button"
        disabled={!dirty || pending || (!!provider && !model)}
        onClick={() =>
          start(async () => {
            await updateAgent(agent.id, {
              provider: (provider || null) as AIProviderId | null,
              model: model || null,
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 1600);
          })
        }
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg px-3 font-mono text-[10px] uppercase tracking-widest transition",
          dirty
            ? "bg-plasma/15 text-plasma hover:bg-plasma/25"
            : "border border-white/8 text-ink-faint",
          pending && "opacity-50",
        )}
      >
        {saved && <Check className="size-3" />}
        {pending ? "…" : saved ? "saved" : "save"}
      </button>
    </div>
  );
}

/**
 * Which brain each scheduled agent runs on — the same per-agent override as the
 * agent's own page, surfaced here so every model choice in apOS is reachable
 * from Settings. "route default" means it inherits the `agent.default` route.
 */
export function AgentModelsPanel({ agents }: { agents: AgentModelRow[] }) {
  const cloud = agents.filter((a) => a.provider && isCloudProvider(a.provider)).length;
  return (
    <section className="glass rounded-2xl p-5">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        agent models — which brain runs each agent
      </p>
      <p className="mb-4 text-xs text-ink-faint">
        Per-agent override; beats the <code className="text-ion">agent.default</code>{" "}
        route (Settings → Models &amp; Routing). Periodic agents should stay on a free local model — {" "}
        <span className={cloud > 0 ? "text-solar" : "text-plasma"}>
          {cloud} of {agents.length}
        </span>{" "}
        currently use a cloud model.
      </p>
      <div className="flex flex-col gap-2">
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} />
        ))}
      </div>
    </section>
  );
}
