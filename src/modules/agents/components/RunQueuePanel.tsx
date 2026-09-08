"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import type { RunQueueEntry, RunQueueState } from "../queries";
import { runDuration } from "./runMeta";

/** Compact elapsed since an ISO instant, ticking live ("2m 14s", "45s"). */
function elapsed(fromIso: string, now: number): string {
  return runDuration(new Date(fromIso), new Date(now));
}

function QueueRow({
  entry,
  now,
  position,
}: {
  entry: RunQueueEntry;
  now: number;
  /** 1-based place in the waiting line, for queued rows only. */
  position: number | null;
}) {
  const running = entry.status === "running";
  const color = running ? "var(--color-solar)" : "var(--color-ion)";
  const inner = (
    <>
      <span
        className={cn("dot", running && "animate-pulse-soft")}
        style={{ color }}
      />
      {/* chat prompts are externally-initiated — dim the label to tell them
          apart from agents at a glance. */}
      <span
        className={cn(
          "truncate text-sm",
          entry.kind === "chat" ? "text-ink-faint italic" : "text-ink-dim",
        )}
      >
        {entry.label}
      </span>
      <span className="rounded border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
        {entry.trigger}
      </span>
      <span
        className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-widest"
        style={{ color }}
      >
        {running
          ? `running ${entry.startedAt ? elapsed(entry.startedAt, now) : ""}`
          : `${position === 1 ? "next · " : `#${position} · `}waiting ${elapsed(entry.createdAt, now)}`}
      </span>
    </>
  );
  const cls = "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/4";
  // Agents link to their detail page; chat runs have none.
  return entry.href ? (
    <Link href={entry.href} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/**
 * Live view of the agent-run admission queue — for debug, clarity and
 * governance. Shows the concurrency policy and every in-flight run (executing +
 * waiting), so it's visible WHY a run is sitting in line rather than running.
 * Data is server-fetched and refreshes on `agent_runs` events; a local 1s tick
 * keeps the elapsed timers moving between refreshes.
 */
export function RunQueuePanel({ state }: { state: RunQueueState }) {
  const [now, setNow] = useState(() => Date.now());
  useLiveEvents(["agent_runs", "chat_runs"]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const running = state.entries.filter((e) => e.status === "running");
  const queued = state.entries.filter((e) => e.status === "queued");

  return (
    <div className="glass rounded-xl p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          <Layers className="size-3" /> run queue
        </span>
        <span className="rounded border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          capacity · {state.capacity} at a time
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          <span className="text-solar">{running.length} running</span>
          <span className="mx-1.5 text-ink-faint">·</span>
          <span className="text-ion">{queued.length} queued</span>
        </span>
      </div>
      {state.entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/6 py-4 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          idle — nothing running or queued
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {running.map((e) => (
            <QueueRow key={e.runId} entry={e} now={now} position={null} />
          ))}
          {queued.map((e, i) => (
            <QueueRow key={e.runId} entry={e} now={now} position={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
