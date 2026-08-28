"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, Play, Trash2, Wrench } from "lucide-react";
import type { Agent, AgentRun } from "@/core/db/schema/agents";
import { AI_PROVIDERS, isCloudProvider, type AIProviderId } from "@/core/db/schema/ai-routes";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { useProviderModels } from "@/core/ui/useProviderModels";
import { deleteAgent, requestRun, updateAgent } from "../actions";
import type { AgentDocView } from "../agent-doc";
import { RUN_STATUS_META, runDuration } from "./runMeta";

interface TranscriptEvent {
  type: string;
  text?: string;
  name?: string;
  result?: unknown;
  message?: string;
}

function Transcript({ run }: { run: AgentRun }) {
  const events = (run.transcript ?? []) as TranscriptEvent[];
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-white/5 pt-3">
      {events.map((e, i) => {
        if (e.type === "tool_call") {
          return (
            <span
              key={i}
              className="inline-flex w-fit items-center gap-1.5 rounded-md border border-ion/25 bg-ion/8 px-2 py-0.5 font-mono text-[10px] text-ion"
            >
              <Wrench className="size-3" />
              {e.name}
            </span>
          );
        }
        if (e.type === "tool_result") {
          const s = JSON.stringify(e.result ?? "");
          return (
            <p key={i} className="font-mono text-[10px] leading-relaxed text-ink-faint">
              ↳ {s.length > 200 ? s.slice(0, 200) + "…" : s}
            </p>
          );
        }
        if (e.type === "text" && e.text) {
          return (
            <p key={i} className="whitespace-pre-wrap text-xs leading-relaxed text-ink-dim">
              {e.text}
            </p>
          );
        }
        if (e.type === "error") {
          return (
            <p key={i} className="font-mono text-xs text-flare">
              {e.message}
            </p>
          );
        }
        return null;
      })}
      {run.result && (
        <div className="rounded-lg border border-plasma/20 bg-plasma/5 p-3">
          <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-plasma">
            final report
          </p>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
            {run.result}
          </p>
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  const status = RUN_STATUS_META[run.status];
  return (
    <div className="glass rounded-xl p-3.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 text-left"
      >
        <span
          className={cn(
            "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
            status.pulse && "animate-pulse-soft",
          )}
          style={{ color: status.color }}
        >
          <span className="dot" style={{ color: status.color }} />
          {status.label}
        </span>
        <span className="font-mono text-[10px] uppercase text-ink-faint">
          {run.trigger}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">
          {run.startedAt
            ? new Date(run.startedAt).toLocaleString(undefined, {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—"}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-dim">
          {runDuration(
            run.startedAt ? new Date(run.startedAt) : null,
            run.finishedAt ? new Date(run.finishedAt) : null,
          )}
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
          {run.tokensIn + run.tokensOut > 0
            ? `${run.tokensIn}▾ ${run.tokensOut}▴ tok`
            : ""}
        </span>
        <ChevronDown
          className={cn("size-3.5 text-ink-faint transition", open && "rotate-180")}
        />
      </button>
      {run.error && (
        <p className="mt-2 font-mono text-[10px] text-flare">{run.error}</p>
      )}
      {open && <Transcript run={run} />}
    </div>
  );
}

export function AgentDetail({
  agent,
  runs,
  allTools,
  defaultRoute,
  doc,
}: {
  agent: Agent;
  runs: AgentRun[];
  allTools: string[];
  /** What this agent falls back to when it has no provider/model override. */
  defaultRoute: { providerId: AIProviderId; model: string };
  /** Derived "how it works": what it reads / suggests / learns. */
  doc: AgentDocView;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [prompt, setPrompt] = useState(agent.prompt);
  const [schedule, setSchedule] = useState(agent.schedule ?? "");
  const [tools, setTools] = useState<string[]>(agent.tools);
  const [provider, setProvider] = useState<AIProviderId | "">(agent.provider ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [fallbackModel, setFallbackModel] = useState(agent.fallbackModel ?? "");
  const [turnBudget, setTurnBudget] = useState(
    agent.turnBudget != null ? String(agent.turnBudget) : "",
  );

  useLiveEvents(["agent_runs"]);

  const { models } = useProviderModels(provider);
  // The fallback is always a LOCAL retry target, regardless of the primary
  // provider — only relevant (and only shown) when the primary is cloud.
  const { models: ollamaModels } = useProviderModels(provider ? "ollama" : "");
  const showFallback = provider !== "" && isCloudProvider(provider);

  const dirty =
    name !== agent.name ||
    description !== (agent.description ?? "") ||
    prompt !== agent.prompt ||
    schedule !== (agent.schedule ?? "") ||
    JSON.stringify(tools) !== JSON.stringify(agent.tools) ||
    provider !== (agent.provider ?? "") ||
    model !== (agent.model ?? "") ||
    fallbackModel !== (agent.fallbackModel ?? "") ||
    turnBudget !== (agent.turnBudget != null ? String(agent.turnBudget) : "");

  const grouped = allTools.reduce<Record<string, string[]>>((acc, t) => {
    const mod = t.split(".")[0];
    (acc[mod] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="max-w-3xl">
      <div className="mb-5 flex items-center gap-3">
        <Link
          href="/m/agents"
          className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
        >
          <ArrowLeft className="size-3" /> agents
        </Link>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await requestRun(agent.id);
            })
          }
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-flare/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-flare transition hover:bg-flare/25 disabled:opacity-40"
        >
          <Play className="size-3" /> run now
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            startTransition(async () => {
              await deleteAgent(agent.id);
              router.push("/m/agents");
            });
          }}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
            confirmDelete
              ? "border-flare/50 bg-flare/15 text-flare"
              : "border-white/8 text-ink-faint hover:text-flare",
          )}
        >
          <Trash2 className="size-3" />
          {confirmDelete ? "sure?" : "delete"}
        </button>
      </div>

      {/* How it works — derived from the agent's tools + the shared learning loop */}
      <div className="glass mb-5 rounded-2xl p-5">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
          how it works
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink">Reads (inputs)</p>
            <ul className="space-y-1">
              {doc.reads.length ? (
                doc.reads.map((r) => (
                  <li key={r.name} className="text-[11px] leading-snug text-ink-dim">
                    <code className="text-ion">{r.name}</code> — {r.gist}
                  </li>
                ))
              ) : (
                <li className="text-[11px] text-ink-faint">—</li>
              )}
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink">Suggests / acts</p>
            <ul className="space-y-1">
              {doc.suggests.length ? (
                doc.suggests.map((s) => (
                  <li key={s.name} className="text-[11px] leading-snug text-ink-dim">
                    <code className="text-flare">{s.name}</code> — {s.gist}
                  </li>
                ))
              ) : (
                <li className="text-[11px] text-ink-faint">
                  Read-only — produces briefs/digests, raises nothing.
                </li>
              )}
            </ul>
          </div>
        </div>
        <div className="mt-4 border-t border-white/5 pt-3">
          <p className="mb-1 text-xs font-semibold text-ink">Learns</p>
          <p className="text-[11px] leading-snug text-ink-faint">{doc.learns}</p>
        </div>
        <p className="mt-2 text-[10px] text-ink-faint">
          Decides per its mission prompt below.
        </p>
      </div>

      <div className="glass mb-5 flex flex-col gap-4 rounded-2xl p-5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-transparent font-display text-2xl font-semibold text-ink outline-none"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this agent for?"
          className="bg-transparent text-sm text-ink-dim outline-none placeholder:text-ink-faint"
        />
        <div>
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            mission prompt
          </p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="w-full resize-y rounded-lg border border-white/8 bg-abyss/50 p-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-flare/30"
          />
        </div>
        <div>
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            schedule (cron, empty = manual only)
          </p>
          <input
            value={schedule}
            onChange={(e) => {
              setSchedule(e.target.value);
              setScheduleError(null);
            }}
            placeholder="0 8 * * *"
            className="w-48 rounded-lg border border-white/8 bg-abyss/50 px-3 py-2 font-mono text-xs text-ink outline-none focus:border-flare/30"
          />
          {scheduleError && (
            <p className="mt-1 font-mono text-[10px] text-flare">{scheduleError}</p>
          )}
        </div>
        <div>
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            model
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as AIProviderId | "");
                setModel("");
              }}
              className="h-9 rounded-lg border border-white/8 bg-abyss/50 px-3 font-mono text-xs text-ink outline-none focus:border-flare/30"
            >
              <option value="">use default route</option>
              {AI_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {provider && (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-9 min-w-56 flex-1 rounded-lg border border-white/8 bg-abyss/50 px-3 font-mono text-xs text-ink outline-none focus:border-flare/30"
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
            )}
          </div>
          {!provider && (
            <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
              no override — currently uses the default route:{" "}
              <span className="text-ink-dim">
                {defaultRoute.providerId} / {defaultRoute.model}
              </span>
            </p>
          )}
          {showFallback && (
            <div className="mt-2.5">
              <p className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                fallback (local) — retried automatically if the cloud call fails
              </p>
              <select
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                className="h-9 w-64 rounded-lg border border-white/8 bg-abyss/50 px-3 font-mono text-xs text-ink outline-none focus:border-flare/30"
              >
                <option value="">no fallback</option>
                {ollamaModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="mt-2.5">
            <p className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              turn budget — tool-loop steps per run (blank = provider default)
            </p>
            <input
              type="number"
              min={1}
              max={100}
              value={turnBudget}
              onChange={(e) => setTurnBudget(e.target.value)}
              placeholder="default"
              className="h-9 w-32 rounded-lg border border-white/8 bg-abyss/50 px-3 font-mono text-xs text-ink outline-none focus:border-flare/30"
            />
            <span className="ml-2 font-mono text-[9px] text-ink-faint">
              raise for many-item runs (digest N projects, edit N files)
            </span>
          </div>
        </div>
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            allowed tools{" "}
            <span className="normal-case tracking-normal">
              (ledger.has / ledger.mark always available)
            </span>
          </p>
          <div className="flex flex-col gap-2.5">
            {Object.entries(grouped).map(([mod, names]) => (
              <div key={mod} className="flex flex-wrap items-center gap-2">
                <span className="w-20 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
                  {mod}
                </span>
                {names.map((t) => {
                  const on = tools.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() =>
                        setTools((prev) =>
                          on ? prev.filter((x) => x !== t) : [...prev, t],
                        )
                      }
                      className={cn(
                        "rounded-md border px-2 py-1 font-mono text-[10px] transition",
                        on
                          ? "border-plasma/40 bg-plasma/10 text-plasma"
                          : "border-white/8 text-ink-faint hover:text-ink-dim",
                      )}
                    >
                      {t.split(".")[1]}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={!dirty || pending || (provider !== "" && !model)}
          onClick={() =>
            startTransition(async () => {
              try {
                await updateAgent(agent.id, {
                  name,
                  description: description || null,
                  prompt,
                  schedule: schedule || null,
                  tools,
                  provider: provider || null,
                  model: provider ? model : null,
                  // Only meaningful with a cloud primary — clear it otherwise.
                  fallbackModel: showFallback ? fallbackModel || null : null,
                  turnBudget: turnBudget.trim() ? Number(turnBudget) : null,
                });
                setScheduleError(null);
              } catch (e) {
                setScheduleError(String(e).replace(/^Error:\s*/, ""));
              }
            })
          }
          className={cn(
            "self-end rounded-lg px-5 py-2 font-mono text-[11px] uppercase tracking-widest transition",
            dirty
              ? "bg-plasma/15 text-plasma hover:bg-plasma/25"
              : "border border-white/8 text-ink-faint",
          )}
        >
          {pending ? "saving…" : "save"}
        </button>
      </div>

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        run history
      </p>
      <div className="flex flex-col gap-2.5">
        {runs.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/6 py-10 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            never run
          </div>
        )}
        {runs.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
      </div>
    </div>
  );
}
