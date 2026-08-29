"use client";

import { CalendarClock, Check } from "lucide-react";
import { useState, useTransition } from "react";
import { cn } from "@/core/ui/cn";
import { GlassPanel } from "@/core/ui/GlassPanel";
import type { FlowTrigger } from "@/modules/flows/schema";
import { setFlowEnabled, setFlowTrigger } from "../actions";

const PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 8am", cron: "0 8 * * *" },
  { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "Mondays 9am", cron: "0 9 * * 1" },
];

const fieldCls =
  "w-full rounded-lg glass px-2.5 py-1.5 text-sm text-ink outline-none focus:glass-edge";
const labelCls =
  "block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint";

function summarize(t: FlowTrigger, enabled: boolean): string {
  if (t.kind === "schedule") return `${enabled ? "" : "paused · "}${t.cron}`;
  if (t.kind === "event") return `${enabled ? "" : "paused · "}on ${t.channel}`;
  return "manual";
}

export function ScheduleControl({
  flowId,
  trigger,
  enabled,
}: {
  flowId: string;
  trigger: FlowTrigger;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FlowTrigger["kind"]>(trigger.kind);
  const [cron, setCron] = useState(trigger.kind === "schedule" ? trigger.cron : "0 8 * * *");
  const [isEnabled, setIsEnabled] = useState(enabled);
  const [err, setErr] = useState<string | null>(null);
  const [, start] = useTransition();

  const persist = (next: FlowTrigger, nextEnabled: boolean) => {
    setErr(null);
    start(async () => {
      try {
        await setFlowTrigger(flowId, next);
        await setFlowEnabled(flowId, nextEnabled);
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, ""));
      }
    });
  };

  const apply = (nextKind: FlowTrigger["kind"]) => {
    setKind(nextKind);
    const next: FlowTrigger =
      nextKind === "schedule" ? { kind: "schedule", cron } : { kind: "manual" };
    persist(next, nextKind === "manual" ? false : isEnabled);
    if (nextKind === "manual") setIsEnabled(false);
  };

  const armed = trigger.kind !== "manual" && enabled;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
          armed
            ? "border-plasma/40 bg-plasma/10 text-plasma"
            : "border-ink/15 text-ink-faint hover:text-ink",
        )}
        title="Trigger & schedule"
      >
        <CalendarClock className="h-3.5 w-3.5" />
        {summarize(trigger, enabled)}
      </button>

      {open && (
        <GlassPanel className="absolute right-0 top-11 z-30 w-72 p-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className={labelCls}>trigger</span>
              <div className="flex gap-1">
                {(["manual", "schedule"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => apply(k)}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1.5 text-xs capitalize transition",
                      kind === k
                        ? "bg-plasma/15 text-plasma"
                        : "text-ink-dim hover:bg-plasma/5",
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            {kind === "schedule" && (
              <div className="flex flex-col gap-1.5">
                <span className={labelCls}>cron</span>
                <input
                  className={fieldCls}
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  onBlur={() => apply("schedule")}
                  placeholder="0 8 * * *"
                />
                <div className="flex flex-wrap gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.cron}
                      type="button"
                      onClick={() => {
                        setCron(p.cron);
                        setKind("schedule");
                        persist({ kind: "schedule", cron: p.cron }, isEnabled);
                      }}
                      className="rounded-md border border-ink/10 px-1.5 py-0.5 text-[10px] text-ink-dim transition hover:border-plasma/30 hover:text-ink"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {kind !== "manual" && (
              <button
                type="button"
                onClick={() => {
                  const next = !isEnabled;
                  setIsEnabled(next);
                  setFlowEnabled(flowId, next);
                }}
                className="flex items-center justify-between rounded-lg glass px-3 py-2"
              >
                <span className="text-sm text-ink">Armed</span>
                <span
                  className={cn(
                    "flex h-5 w-9 items-center rounded-full px-0.5 transition",
                    isEnabled ? "bg-plasma/40" : "bg-ink/15",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full bg-ink transition",
                      isEnabled ? "translate-x-4" : "translate-x-0",
                    )}
                  >
                    {isEnabled && <Check className="h-2.5 w-2.5 text-void" />}
                  </span>
                </span>
              </button>
            )}

            {err && <p className="text-[11px] text-flare">{err}</p>}
            <p className="text-[11px] text-ink-faint">
              {kind === "manual"
                ? "Runs only when you press Run."
                : "The worker fires this flow on the cron when armed."}
            </p>
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
