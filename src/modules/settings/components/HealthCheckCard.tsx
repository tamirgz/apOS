"use client";

import { useState, useTransition } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { checkModelServersNow, saveHealthInterval } from "../actions";

interface ServerStatus {
  id: string;
  label: string;
  url: string;
  ok: boolean;
}

const OPTIONS = [
  { min: 0, label: "Off" },
  { min: 15, label: "15 min" },
  { min: 30, label: "30 min" },
  { min: 60, label: "Hourly" },
  { min: 180, label: "3 hours" },
  { min: 360, label: "6 hours" },
];

export function HealthCheckCard({
  interval,
  initialStatuses,
}: {
  interval: number;
  initialStatuses: ServerStatus[];
}) {
  const [min, setMin] = useState(interval);
  const [statuses, setStatuses] = useState<ServerStatus[]>(initialStatuses);
  const [checked, setChecked] = useState(false);
  const [savePending, startSave] = useTransition();
  const [checkPending, startCheck] = useTransition();

  const pick = (m: number) => {
    const prev = min;
    setMin(m);
    startSave(async () => {
      const r = await act(() => saveHealthInterval(m), { failed: "Couldn't save the check interval" });
      if (!r.ok) setMin(prev);
    });
  };
  const checkNow = () => {
    startCheck(async () => {
      const r = await act(() => checkModelServersNow(), { failed: "Couldn't check the model servers" });
      if (!r.ok) return;
      setStatuses(r.value);
      setChecked(true);
    });
  };

  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-ion" />
          <h3 className="font-display text-sm font-semibold text-ink">
            Local model servers — health check
          </h3>
        </div>
        <button
          type="button"
          onClick={checkNow}
          disabled={checkPending}
          className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3", checkPending && "animate-spin")} />
          {checkPending ? "checking…" : "check now"}
        </button>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-ink-dim">
        Pings <span className="text-ink">Ollama</span> (and LM Studio, if
        configured) on a schedule and alerts the bell + Slack if one goes down —
        local search, chat, and agents depend on them. Runs in the worker.
      </p>

      {/* interval */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          every
        </span>
        {OPTIONS.map((o) => (
          <button
            key={o.min}
            type="button"
            onClick={() => pick(o.min)}
            disabled={savePending}
            className={cn(
              "rounded-lg px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-40",
              min === o.min
                ? "bg-ion/15 text-ion"
                : "text-ink-faint hover:bg-white/5 hover:text-ink-dim",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* statuses */}
      {statuses.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {statuses.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2 rounded-lg border border-white/6 px-3 py-1.5"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  s.ok ? "bg-plasma" : "bg-flare",
                )}
              />
              <span className="text-sm text-ink">{s.label}</span>
              <span
                className={cn(
                  "ml-auto font-mono text-[10px] uppercase tracking-widest",
                  s.ok ? "text-plasma" : "text-flare",
                )}
              >
                {s.ok ? "reachable" : "down"}
              </span>
            </div>
          ))}
          {!checked && (
            <p className="px-1 pt-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              status as of the last check · hit “check now” to refresh
            </p>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-white/6 py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          not checked yet — hit “check now”
        </p>
      )}
    </div>
  );
}
