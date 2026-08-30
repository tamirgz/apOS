"use client";

import { timeAgo } from "@/core/ui/time";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Compass,
  Layers,
  ListPlus,
  OctagonAlert,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import {
  advisorToFeature,
  advisorToTask,
  reconsiderProject,
  runProjectAdvisor,
} from "../actions";

const ago = (d: Date | string | null) => timeAgo(d);

/** P1 Project Advisor — grounded read + act-on-it controls. */
export function AdvisorPanel({
  projectId,
  state,
  blocker,
  next,
  updatedAt,
}: {
  projectId: string;
  state: string | null;
  blocker: string | null;
  next: string | null;
  updatedAt: Date | string | null;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [pending, start] = useTransition();
  const [did, setDid] = useState<string | null>(null);
  const [angleOpen, setAngleOpen] = useState(false);
  const [angle, setAngle] = useState("");

  const reRead = () => {
    setRunning(true);
    void runProjectAdvisor().finally(() => {
      setTimeout(() => {
        setRunning(false);
        router.refresh();
      }, 4000);
    });
  };

  const act = (fn: () => Promise<unknown>, label: string) =>
    start(async () => {
      await fn();
      setDid(label);
      setTimeout(() => setDid(null), 2000);
      router.refresh();
    });

  const reconsider = () => {
    const a = angle.trim();
    if (!a) return;
    setRunning(true);
    setAngleOpen(false);
    void reconsiderProject(projectId, a).finally(() => {
      setAngle("");
      setTimeout(() => {
        setRunning(false);
        router.refresh();
      }, 4000);
    });
  };

  return (
    <section className="glass rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <Compass className="size-4 text-ion" />
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          advisor
        </p>
        {updatedAt && (
          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            · read {ago(updatedAt)} · haiku
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAngleOpen((o) => !o)}
            disabled={running}
            title="Ask the advisor to reconsider this project from a different angle"
            className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:text-ink-dim disabled:opacity-50"
          >
            <Sparkles className="size-3" /> angle
          </button>
          <button
            type="button"
            onClick={reRead}
            disabled={running}
            title="Re-read all active projects"
            className="flex items-center gap-1.5 rounded-lg border border-ion/25 bg-ion/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-ion transition hover:bg-ion/20 disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3", running && "animate-spin")} />
            {running ? "reading…" : "re-read"}
          </button>
        </div>
      </div>

      {angleOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reconsider();
          }}
          className="mb-3 flex items-center gap-2"
        >
          <input
            autoFocus
            value={angle}
            onChange={(e) => setAngle(e.target.value)}
            placeholder="Reconsider from a different angle — e.g. 'focus on go-to-market' · 'be more critical' · 'what's the fastest path to demo?'"
            className="h-8 flex-1 rounded-lg bg-white/5 px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
          />
          <button
            type="submit"
            className="rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25"
          >
            reconsider
          </button>
        </form>
      )}

      {state ? (
        <div className="flex flex-col gap-2.5">
          <p dir="auto" className="text-sm leading-relaxed text-ink-dim">
            {state}
          </p>
          {blocker && (
            <p className="flex items-start gap-2 rounded-lg border border-flare/20 bg-flare/5 px-3 py-2 text-sm text-flare">
              <OctagonAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="font-mono text-[9px] uppercase tracking-widest opacity-70">
                  blocker
                </span>
                <br />
                {blocker}
              </span>
            </p>
          )}
          {next && (
            <div className="flex flex-col gap-1.5">
              <p className="flex items-start gap-2 text-sm text-ink-dim">
                <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-plasma" />
                <span>
                  <span className="font-mono text-[9px] uppercase tracking-widest text-plasma/70">
                    next move
                  </span>
                  <br />
                  {next}
                </span>
              </p>
              {/* Act on the recommendation — turn it into a task or a feature. */}
              <div className="flex items-center gap-1.5 pl-6">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => act(() => advisorToTask(projectId, next), "task")}
                  className="flex items-center gap-1 rounded-md border border-white/8 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:border-plasma/30 hover:text-plasma disabled:opacity-50"
                >
                  <ListPlus className="size-3" /> task
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => act(() => advisorToFeature(projectId, next), "feature")}
                  className="flex items-center gap-1 rounded-md border border-white/8 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:border-ion/30 hover:text-ion disabled:opacity-50"
                >
                  <Layers className="size-3" /> feature
                </button>
                {did && (
                  <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-plasma">
                    <Check className="size-3" /> {did} created
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-ink-faint">
          No advisor read yet — hit <span className="text-ion">re-read</span> to have
          the chief-of-staff assess this project from its tasks, notes and code.
        </p>
      )}
    </section>
  );
}
