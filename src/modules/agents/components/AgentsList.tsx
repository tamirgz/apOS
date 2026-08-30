"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Bot, CalendarClock, Play, Plus } from "lucide-react";
import type { Agent, AgentRun } from "@/core/db/schema/agents";
import type { AgentTemplate } from "@/core/modules/types.server";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { createAgent, createFromTemplate, requestRun, updateAgent } from "../actions";
import { RUN_STATUS_META } from "./runMeta";

function EnabledSwitch({ agent }: { agent: Agent }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      title={agent.enabled ? "Disable agent" : "Enable agent"}
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        startTransition(async () => {
          await updateAgent(agent.id, { enabled: !agent.enabled });
        });
      }}
      className={cn(
        "relative h-5 w-9 rounded-full border transition",
        agent.enabled
          ? "border-plasma/40 bg-plasma/25"
          : "border-white/10 bg-white/5",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full transition-all",
          agent.enabled ? "left-4.5 bg-plasma" : "left-0.5 bg-ink-faint",
        )}
      />
    </button>
  );
}

function RunNowButton({ agentId }: { agentId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        startTransition(async () => {
          await requestRun(agentId);
        });
      }}
      className="flex items-center gap-1.5 rounded-lg border border-flare/25 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-flare transition hover:bg-flare/10 disabled:opacity-40"
    >
      <Play className="size-3" />
      {pending ? "…" : "run now"}
    </button>
  );
}

function AgentCard({
  agent,
  latestRun,
  gateLast,
  index,
}: {
  agent: Agent;
  latestRun: AgentRun | null;
  gateLast: { at: string; run: boolean; reason: string } | null;
  index: number;
}) {
  const status = latestRun ? RUN_STATUS_META[latestRun.status] : null;
  // The most recent cron fire was gate-skipped (nothing to act on) — show
  // that instead of leaving "it didn't run" looking like a failure.
  const skipped =
    gateLast &&
    !gateLast.run &&
    (!latestRun?.createdAt || new Date(gateLast.at) > new Date(latestRun.createdAt));
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32, delay: index * 0.04 }}
    >
      <Link
        href={`/m/agents/${agent.id}`}
        className={cn(
          "glass block rounded-xl p-4 transition hover:bg-white/4",
          !agent.enabled && "opacity-60",
        )}
      >
        <div className="mb-2 flex items-center gap-3">
          <Bot className="size-4.5 text-flare" />
          <h3 className="font-display text-base font-medium text-ink">
            {agent.name}
          </h3>
          <span className="ml-auto" onClick={(e) => e.preventDefault()}>
            <EnabledSwitch agent={agent} />
          </span>
        </div>
        {agent.description && (
          <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-ink-dim">
            {agent.description}
          </p>
        )}
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            <CalendarClock className="size-3" />
            {agent.schedule ?? "manual"}
          </span>
          {skipped ? (
            <span
              className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint"
              title={gateLast!.reason}
            >
              <span className="dot" />
              <span className="truncate normal-case tracking-normal">
                skipped — {gateLast!.reason}
              </span>
            </span>
          ) : status ? (
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
          ) : null}
          <span className="ml-auto">
            <RunNowButton agentId={agent.id} />
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

export function AgentsList({
  items,
  templates,
}: {
  items: {
    agent: Agent;
    latestRun: AgentRun | null;
    gateLast: { at: string; run: boolean; reason: string } | null;
  }[];
  templates: (AgentTemplate & { moduleId: string })[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useLiveEvents(["agent_runs", "agents_changed"]);

  const installedNames = new Set(items.map((i) => i.agent.name));

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
            your agents · {items.length}
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const row = await createAgent({
                  name: "New agent",
                  prompt: "Describe this agent's mission here.",
                });
                router.push(`/m/agents/${row.id}`);
              })
            }
            className="flex items-center gap-1.5 rounded-lg bg-flare/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-flare transition hover:bg-flare/25 disabled:opacity-40"
          >
            <Plus className="size-3" /> new agent
          </button>
        </div>
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/6 py-12 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            no agents yet — install a template below or create one
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {items.map((it, i) => (
              <AgentCard
                key={it.agent.id}
                agent={it.agent}
                latestRun={it.latestRun}
                gateLast={it.gateLast}
                index={i}
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          templates — contributed by modules
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {templates.map((t) => (
            <div key={t.id} className="glass rounded-xl p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <h4 className="font-display text-sm font-medium text-ink">
                  {t.name}
                </h4>
                <span className="rounded-md border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  {t.moduleId}
                </span>
              </div>
              <p className="mb-3 text-xs leading-relaxed text-ink-dim">
                {t.description}
              </p>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-ink-faint">
                  {t.defaultSchedule ?? "manual"}
                </span>
                <button
                  type="button"
                  disabled={pending || installedNames.has(t.name)}
                  onClick={() =>
                    startTransition(async () => {
                      const row = await createFromTemplate(t.id);
                      router.push(`/m/agents/${row.id}`);
                    })
                  }
                  className="rounded-lg border border-flare/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-flare transition hover:bg-flare/10 disabled:opacity-40"
                >
                  {installedNames.has(t.name) ? "installed" : "install"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
