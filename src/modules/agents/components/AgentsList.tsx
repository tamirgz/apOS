"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Bot, CalendarClock, Play, Plus } from "lucide-react";
import type { Agent, AgentRun } from "@/core/db/schema/agents";
import type { AgentTemplate } from "@/core/modules/types.server";
import { cn } from "@/core/ui/cn";
import { timeAgo } from "@/core/ui/time";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { createAgent, createFromTemplate, requestRun, updateAgent } from "../actions";
import { RUN_STATUS_META, runDuration } from "./runMeta";

type AgentItem = {
  agent: Agent;
  latestRun: AgentRun | null;
  gateLast: { at: string; run: boolean; reason: string } | null;
  nextRunAt: string | null;
};

/** One at-a-glance health state per agent, driving the strip counts + sort. */
type Health = "running" | "failed" | "timed_out" | "skipped" | "ok" | "idle";

function isSkipped(it: AgentItem): boolean {
  return Boolean(
    it.gateLast &&
      !it.gateLast.run &&
      (!it.latestRun?.createdAt ||
        new Date(it.gateLast.at) > new Date(it.latestRun.createdAt)),
  );
}

function deriveHealth(it: AgentItem): Health {
  const s = it.latestRun?.status;
  if (s === "queued" || s === "running") return "running";
  if (isSkipped(it)) return "skipped";
  if (s === "failed") return "failed";
  if (s === "timed_out") return "timed_out";
  if (s === "succeeded") return "ok";
  return "idle";
}

const HEALTH_META: Record<
  Health,
  { label: string; color: string; rank: number }
> = {
  // rank = sort priority (lower first): problems, then live, then the rest.
  failed: { label: "failed", color: "var(--color-flare)", rank: 0 },
  timed_out: { label: "timed out", color: "var(--color-solar)", rank: 1 },
  running: { label: "running", color: "var(--color-solar)", rank: 2 },
  ok: { label: "ok", color: "var(--color-plasma)", rank: 3 },
  skipped: { label: "skipped", color: "var(--color-ink-faint)", rank: 4 },
  idle: { label: "idle", color: "var(--color-ink-faint)", rank: 5 },
};

/** "in 5m" / "in 3h" / "in 2d" — future counterpart to timeAgo. */
function untilShort(iso: string | null): string | null {
  if (!iso) return null;
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 0) return null;
  if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86_400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86_400)}d`;
}

function StatusStrip({ items }: { items: AgentItem[] }) {
  const counts = { running: 0, failed: 0, timed_out: 0, ok: 0, skipped: 0, idle: 0 };
  for (const it of items) counts[deriveHealth(it)]++;
  // Order the pills problems-first; only render a state that's present.
  const order: Health[] = ["running", "failed", "timed_out", "ok", "skipped", "idle"];
  const shown = order.filter((h) => counts[h] > 0);
  const attention = counts.failed + counts.timed_out;
  return (
    <div className="glass flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        {attention > 0
          ? `${attention} need${attention === 1 ? "s" : ""} attention`
          : "all healthy"}
      </span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {shown.map((h) => (
          <span
            key={h}
            className={cn(
              "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
              h === "running" && "animate-pulse-soft",
            )}
            style={{ color: HEALTH_META[h].color }}
          >
            <span className="dot" style={{ color: HEALTH_META[h].color }} />
            {counts[h]} {HEALTH_META[h].label}
          </span>
        ))}
      </div>
    </div>
  );
}

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
  nextRunAt,
  index,
}: {
  agent: Agent;
  latestRun: AgentRun | null;
  gateLast: { at: string; run: boolean; reason: string } | null;
  nextRunAt: string | null;
  index: number;
}) {
  const status = latestRun ? RUN_STATUS_META[latestRun.status] : null;
  // The most recent cron fire was gate-skipped (nothing to act on) — show
  // that instead of leaving "it didn't run" looking like a failure.
  const skipped =
    gateLast &&
    !gateLast.run &&
    (!latestRun?.createdAt || new Date(gateLast.at) > new Date(latestRun.createdAt));
  // Footer facts: when it last ran (+ how long it took) and when it fires next.
  const lastAt = latestRun?.finishedAt ?? latestRun?.createdAt ?? null;
  const isLive =
    latestRun?.status === "running" || latestRun?.status === "queued";
  const dur =
    latestRun?.startedAt && latestRun?.finishedAt
      ? // Server→client serialization turns timestamps into strings; runDuration
        // needs real Dates for getTime().
        runDuration(new Date(latestRun.startedAt), new Date(latestRun.finishedAt))
      : null;
  const nextIn = untilShort(nextRunAt);
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32, delay: index * 0.04 }}
      className={cn(
        "glass relative rounded-xl p-4 transition hover:bg-white/4",
        !agent.enabled && "opacity-60",
      )}
    >
      {/* Stretched link — the whole card navigates, but as a SIBLING of the
          controls (not their parent), so no <button> is nested inside an <a>. */}
      <Link
        href={`/m/agents/${agent.id}`}
        aria-label={`Open ${agent.name}`}
        className="absolute inset-0 z-0 rounded-xl"
      />
      {/* Content sits above the stretched link; its non-interactive parts pass
          clicks through, while the toggle + run button re-enable pointer events. */}
      <div className="pointer-events-none relative z-10">
        <div className="mb-2 flex items-center gap-3">
          <Bot className="size-4.5 text-flare" />
          <h3 className="font-display text-base font-medium text-ink">
            {agent.name}
          </h3>
          <span className="pointer-events-auto ml-auto">
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
          <span className="pointer-events-auto ml-auto">
            <RunNowButton agentId={agent.id} />
          </span>
        </div>
        {/* Footer facts — last run (+ duration) and next scheduled fire. */}
        <div className="mt-2.5 flex items-center gap-3 border-t border-white/5 pt-2 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          <span>
            {isLive
              ? "running now"
              : lastAt
                ? `ran ${timeAgo(lastAt)}${dur ? ` · ${dur}` : ""}`
                : "never run"}
          </span>
          {nextIn && (
            <span className="ml-auto normal-case tracking-normal">
              next {nextIn}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function AgentsList({
  items,
  templates,
}: {
  items: AgentItem[];
  templates: (AgentTemplate & { moduleId: string })[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useLiveEvents(["agent_runs", "agents_changed"]);

  const installedNames = new Set(items.map((i) => i.agent.name));
  // Problems first, then live, then healthy — so what needs eyes sits at the
  // top. Disabled agents sink; stable name order within a rank.
  const sorted = [...items].sort((a, b) => {
    if (a.agent.enabled !== b.agent.enabled) return a.agent.enabled ? -1 : 1;
    const ra = HEALTH_META[deriveHealth(a)].rank;
    const rb = HEALTH_META[deriveHealth(b)].rank;
    if (ra !== rb) return ra - rb;
    return a.agent.name.localeCompare(b.agent.name);
  });

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
          <div className="flex flex-col gap-4">
            <StatusStrip items={items} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {sorted.map((it, i) => (
                <AgentCard
                  key={it.agent.id}
                  agent={it.agent}
                  latestRun={it.latestRun}
                  gateLast={it.gateLast}
                  nextRunAt={it.nextRunAt}
                  index={i}
                />
              ))}
            </div>
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
