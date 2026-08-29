"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Bot, Plus, Trash2, Workflow } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import type { AgentOption, FlowCard, FlowStats } from "../queries";
import { createFlow, deleteFlow, importAgentAsFlow } from "../actions";

const fmtMs = (ms: number | null) =>
  ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const fmtTokens = (t: number) =>
  t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : `${t}`;

const RUN_META: Record<string, { label: string; cls: string }> = {
  running: { label: "running", cls: "text-plasma" },
  succeeded: { label: "ok", cls: "text-plasma-dim" },
  failed: { label: "failed", cls: "text-flare" },
  queued: { label: "queued", cls: "text-ink-faint" },
  paused: { label: "paused", cls: "text-ink-faint" },
};

export function FlowLibrary({
  flows,
  agents,
  stats,
}: {
  flows: FlowCard[];
  agents: AgentOption[];
  stats: Record<string, FlowStats>;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [pending, start] = useTransition();
  const [importing, setImporting] = useState(false);
  const newGuard = useRef(false);
  useLiveEvents(["flows_changed", "flow_runs"]);

  // ⌘K "New flow" → /m/studio?new=1 lands here and auto-creates one.
  useEffect(() => {
    if (search.get("new") === "1" && !newGuard.current) {
      newGuard.current = true;
      start(async () => router.push(`/m/studio/${await createFlow()}`));
    }
  }, [search, router]);

  const onNew = () =>
    start(async () => router.push(`/m/studio/${await createFlow()}`));

  const onImport = (agentId: string) => {
    setImporting(false);
    start(async () => router.push(`/m/studio/${await importAgentAsFlow(agentId)}`));
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-ink-faint">
            flows
          </p>
          <h1 className="font-display text-3xl font-semibold text-ink">Studio</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-dim">
            Wire agents, sources and logic into multi-agent procedures. One
            agent&rsquo;s result routes into the next — branch, fan-out, merge.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setImporting((v) => !v)}
              disabled={pending || agents.length === 0}
              className="flex items-center gap-2 rounded-lg border border-plasma/25 px-3 py-2 font-mono text-xs uppercase tracking-widest text-ink-dim transition hover:bg-plasma/10 disabled:opacity-40"
            >
              <Bot className="h-3.5 w-3.5" /> Import agent
            </button>
            {importing && (
              <GlassPanel className="absolute right-0 top-11 z-20 max-h-72 w-64 overflow-auto p-1.5">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onImport(a.id)}
                    className="block w-full truncate rounded-md px-3 py-2 text-left text-sm text-ink-dim transition hover:bg-plasma/10 hover:text-ink"
                  >
                    {a.name}
                  </button>
                ))}
              </GlassPanel>
            )}
          </div>
          <button
            type="button"
            onClick={onNew}
            disabled={pending}
            className="flex items-center gap-2 rounded-lg border border-plasma/40 bg-plasma/10 px-3 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/20 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> New flow
          </button>
        </div>
      </header>

      {flows.length === 0 ? (
        <GlassPanel className="flex flex-col items-center gap-3 px-8 py-20 text-center">
          <Workflow className="h-8 w-8 text-ink-faint" />
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-ink-faint">
            no flows yet
          </p>
          <p className="max-w-sm text-sm text-ink-dim">
            Start from scratch, or import an existing agent as a one-node flow
            and grow it on the canvas.
          </p>
        </GlassPanel>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {flows.map((f) => (
            <FlowTile
              key={f.flow.id}
              card={f}
              stats={stats[f.flow.id]}
              onOpen={() => router.push(`/m/studio/${f.flow.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlowTile({
  card,
  stats,
  onOpen,
}: {
  card: FlowCard;
  stats?: FlowStats;
  onOpen: () => void;
}) {
  const [, startDel] = useTransition();
  const run = card.lastRun ? RUN_META[card.lastRun.status] : null;
  const okRate =
    stats && stats.runs > 0 ? Math.round((stats.succeeded / stats.runs) * 100) : null;
  return (
    <GlassPanel
      className="group relative flex cursor-pointer flex-col gap-3 p-4 transition hover:glass-edge"
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate font-display text-lg font-semibold text-ink">
          {card.flow.name}
        </h3>
        <button
          type="button"
          title="Delete flow"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${card.flow.name}"? This removes its run history.`))
              startDel(async () => deleteFlow(card.flow.id));
          }}
          className="rounded-md p-1 text-ink-faint opacity-0 transition hover:text-flare group-hover:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        <span>{card.nodeCount} nodes</span>
        <span>{card.agentCount} agents</span>
        {run && <span className={cn("ml-auto", run.cls)}>{run.label}</span>}
      </div>
      {stats && stats.runs > 0 && (
        <div className="flex items-center gap-3 border-t border-ink/5 pt-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          <span title="total runs">{stats.runs} runs</span>
          <span title="success rate" className={okRate === 100 ? "text-plasma-dim" : undefined}>
            {okRate}% ok
          </span>
          <span title="avg duration">{fmtMs(stats.avgMs)}</span>
          {stats.tokens > 0 && <span title="agent tokens">{fmtTokens(stats.tokens)} tok</span>}
        </div>
      )}
    </GlassPanel>
  );
}
