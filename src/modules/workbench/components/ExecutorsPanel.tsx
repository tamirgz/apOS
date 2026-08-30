"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Cpu, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { requestFreeModelVerify, updateExecutor } from "../actions";
import type { FreeModelHealthSummary } from "../model-health";

export interface ExecutorRow {
  id: string;
  name: string;
  kind: string;
  defaultModel: string | null;
  commandTemplate: string | null;
  gitMode: string;
  enabled: string;
}

/**
 * Executors as configuration. Editing a row here is how a new coding agent
 * joins apOS — no code, no deploy: a command template with {{prompt}},
 * {{workdir}} and {{model}} placeholders, plus which model it defaults to.
 */
import { timeAgo } from "@/core/ui/time";

/** "Verify free models" — probes the free cloud catalog and prunes the dead. */
function VerifyFreeModels({
  health,
}: {
  health: FreeModelHealthSummary | null;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  // The worker NOTIFYs workbench_changed when the verify pass finishes.
  useLiveEvents(["workbench_changed"], () => {
    if (running) {
      setRunning(false);
      router.refresh();
    }
  });

  const start = () => {
    setRunning(true);
    void requestFreeModelVerify(true);
    // Safety valve so the button never sticks if no event arrives.
    setTimeout(() => setRunning(false), 180_000);
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/6 bg-abyss/40 px-3 py-2">
      <ShieldCheck className="size-3.5 text-ion" />
      {health ? (
        <span className="font-mono text-[10px] text-ink-dim">
          <span className="text-plasma">{health.ok} live</span>
          {health.gone > 0 && <span className="text-flare"> · {health.gone} retired</span>}
          {health.error > 0 && <span className="text-solar"> · {health.error} failing</span>}
          {health.unknown > 0 && <span className="text-ink-faint"> · {health.unknown} unchecked</span>}
          <span className="text-ink-faint"> · checked {timeAgo(health.at)}</span>
        </span>
      ) : (
        <span className="font-mono text-[10px] text-ink-faint">
          free cloud models never verified — dead/retired ones may still be listed
        </span>
      )}
      <button
        type="button"
        disabled={running}
        onClick={start}
        title="Live-probe the free cloud models ($0) and hide the retired/broken ones"
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-ion/25 bg-ion/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-ion transition hover:bg-ion/20 disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3", running && "animate-spin")} />
        {running ? "verifying…" : "verify free models"}
      </button>
    </div>
  );
}

export function ExecutorsPanel({
  executors,
  modelsByExecutor,
  freeModelHealth,
}: {
  executors: ExecutorRow[];
  /** Free models each executor may use — local + its free cloud tiers. */
  modelsByExecutor: Record<string, string[]>;
  /** Last verify pass's tally, or null if never run. */
  freeModelHealth: FreeModelHealthSummary | null;
}) {
  // Total distinct free models offered — for the intro copy.
  const totalFree = new Set(Object.values(modelsByExecutor).flat()).size;
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Partial<ExecutorRow>>>({});

  const set = (id: string, patch: Partial<ExecutorRow>) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  return (
    <section className="glass rounded-2xl p-5">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        workbench executors
      </p>
      <p className="mb-4 text-xs text-ink-faint">
        Who does the work when you delegate. Local executors (opencode, pi)
        are free — the model field offers each one&apos;s free library
        ({totalFree} across all of them: local Ollama, plus opencode-zen&apos;s
        free tier and your Nvidia free models for opencode), and only free
        models are allowed to run on them. Claude costs Max quota but handles
        the hard ones. Placeholders:{" "}
        <code className="text-ion">{"{{prompt}}"}</code>{" "}
        <code className="text-ion">{"{{workdir}}"}</code>{" "}
        <code className="text-ion">{"{{model}}"}</code>
      </p>

      <VerifyFreeModels health={freeModelHealth} />

      <div className="flex flex-col gap-3">
        {executors.map((x) => {
          const d = { ...x, ...draft[x.id] };
          const isCli = x.kind === "cli";
          const dirty = !!draft[x.id];
          return (
            <div
              key={x.id}
              className="rounded-xl border border-white/6 bg-abyss/40 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                {isCli ? (
                  <Terminal className="size-3.5 text-ion" />
                ) : (
                  <Cpu className="size-3.5 text-plasma" />
                )}
                <span className="text-sm text-ink">{x.name}</span>
                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  {x.kind} · {x.gitMode}
                </span>

                <label className="ml-auto flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  <input
                    type="checkbox"
                    checked={d.enabled !== "false"}
                    onChange={(e) =>
                      set(x.id, { enabled: e.target.checked ? "true" : "false" })
                    }
                    className="accent-plasma"
                  />
                  enabled
                </label>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="w-14 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  model
                </span>
                <input
                  list={`models-${x.id}`}
                  value={d.defaultModel ?? ""}
                  onChange={(e) => set(x.id, { defaultModel: e.target.value })}
                  placeholder="provider default"
                  className="w-64 rounded-lg border border-white/8 bg-void/60 px-2 py-1 font-mono text-[11px] text-ink-dim outline-none focus:border-plasma/40"
                />
                <datalist id={`models-${x.id}`}>
                  {(modelsByExecutor[x.id] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              {isCli && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="w-14 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                    command
                  </span>
                  <input
                    value={d.commandTemplate ?? ""}
                    onChange={(e) =>
                      set(x.id, { commandTemplate: e.target.value })
                    }
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-white/8 bg-void/60 px-2 py-1 font-mono text-[11px] text-ink-dim outline-none focus:border-plasma/40"
                  />
                </div>
              )}

              {dirty && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await updateExecutor(x.id, {
                        defaultModel: d.defaultModel ?? null,
                        commandTemplate: d.commandTemplate ?? null,
                        enabled: d.enabled ?? "true",
                      });
                      setDraft((s) => {
                        const n = { ...s };
                        delete n[x.id];
                        return n;
                      });
                      setSaved(x.id);
                    })
                  }
                  className={cn(
                    "mt-2.5 flex items-center gap-1.5 rounded-lg bg-plasma/15 px-3 py-1.5",
                    "font-mono text-[10px] uppercase tracking-widest text-plasma",
                    "transition hover:bg-plasma/25 disabled:opacity-40",
                  )}
                >
                  <Check className="size-3" />
                  save
                </button>
              )}
              {saved === x.id && !dirty && (
                <p className="mt-2 font-mono text-[9px] uppercase tracking-widest text-plasma">
                  saved
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
