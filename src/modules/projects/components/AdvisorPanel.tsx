"use client";

import { timeAgo } from "@/core/ui/time";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Compass,
  Layers,
  ListPlus,
  OctagonAlert,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
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
    void act(runProjectAdvisor, { failed: "Couldn't re-read the projects" }).then((r) => {
      if (!r.ok) return setRunning(false);
      setTimeout(() => {
        setRunning(false);
        router.refresh();
      }, 4000);
    });
  };

  const create = (fn: () => Promise<unknown>, label: string) =>
    start(async () => {
      if (!(await act(fn, { failed: `Couldn't create the ${label}` })).ok) return;
      setDid(`${label} created`);
      setTimeout(() => setDid(null), 2000);
      router.refresh();
    });

  /** Advisor → backlog: a work item, named by its identifier once it exists. */
  const toItem = (text: string, kind: "next" | "blocker") =>
    start(async () => {
      const res = await act(() => advisorToTask(projectId, text, kind), { failed: "Couldn't create the work item" });
      if (!res.ok) return;
      const r = res.value;
      setDid(r.existed ? `already ${r.identifier ?? "on the board"}` : `${r.identifier ?? "item"} created`);
      setTimeout(() => setDid(null), 3500);
      router.refresh();
    });

  const doneChip = did && (
    <span className="inline-flex items-center gap-1 text-xs text-plasma">
      <Check className="size-3" /> {did}
    </span>
  );

  const reconsider = () => {
    const a = angle.trim();
    if (!a) return;
    setRunning(true);
    setAngleOpen(false);
    void act(() => reconsiderProject(projectId, a), { failed: "Couldn't reconsider the project" }).then((r) => {
      setAngle("");
      if (!r.ok) return setRunning(false);
      setTimeout(() => {
        setRunning(false);
        router.refresh();
      }, 4000);
    });
  };

  return (
    <section aria-label="Advisor" className="glass flex flex-col gap-3 rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="wk-sec-h">
          <Compass className="size-3.5 text-violet" /> Advisor
        </h3>
        {updatedAt && <span className="text-[11px] text-ink-faint">read {ago(updatedAt)}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAngleOpen((o) => !o)}
            disabled={running}
            title="Ask the advisor to reconsider this project from a different angle"
            className="wk-btn !py-1 text-xs"
          >
            <Sparkles className="size-3.5 text-violet" /> Angle
          </button>
          <button type="button" onClick={reRead} disabled={running} title="Re-read all active projects" className="wk-btn violet !py-1 text-xs">
            <RefreshCw className={cn("size-3.5", running && "animate-spin")} />
            {running ? "Reading…" : "Re-read"}
          </button>
        </div>
      </div>

      {angleOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reconsider();
          }}
          className="flex items-center gap-2"
        >
          <input
            autoFocus
            value={angle}
            onChange={(e) => setAngle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAngleOpen(false)}
            placeholder="Reconsider from a different angle — e.g. 'be more critical' · 'fastest path to a demo?'"
            className="h-8 min-w-0 flex-1 rounded-lg bg-ink/5 px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:bg-ink/8"
          />
          <button type="submit" disabled={!angle.trim()} className="wk-btn violet !py-1 text-xs">
            Reconsider
          </button>
        </form>
      )}

      {state ? (
        <div className="flex flex-col gap-2.5">
          <p dir="auto" className="wk-read !text-[13px]">
            <b>Read</b> · {state}
          </p>
          {blocker && (
            <div className="flex flex-col gap-1.5">
              <p dir="auto" className="wk-read flare !text-[13px]">
                <b>Blocker</b> · {blocker}
              </p>
              <div className="flex items-center gap-1.5 pl-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => toItem(blocker, "blocker")}
                  title="File this blocker as a high-priority work item"
                  className="wk-btn !gap-1 !px-2 !py-0.5 text-[11.5px]"
                >
                  <OctagonAlert className="size-3 text-flare" /> File as item
                </button>
              </div>
            </div>
          )}
          {next && (
            <div className="flex flex-col gap-1.5">
              <p dir="auto" className="wk-read plasma !text-[13px]">
                <b>Next move</b> · {next}
              </p>
              {/* Act on the recommendation — turn it into a work item or a module. */}
              <div className="flex flex-wrap items-center gap-1.5 pl-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => toItem(next, "next")}
                  title="Add this next move to the project's work items"
                  className="wk-btn !gap-1 !px-2 !py-0.5 text-[11.5px]"
                >
                  <ListPlus className="size-3 text-plasma" /> Work item
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => create(() => advisorToFeature(projectId, next), "module")}
                  title="Start a module for this next move"
                  className="wk-btn !gap-1 !px-2 !py-0.5 text-[11.5px]"
                >
                  <Layers className="size-3 text-solar" /> Module
                </button>
                {doneChip}
              </div>
            </div>
          )}
          {!next && doneChip}
        </div>
      ) : (
        <p className="text-[13px] text-ink-faint">
          No advisor read yet — <span className="text-ink-dim">Re-read</span> has the chief-of-staff assess this project from its items,
          notes and code.
        </p>
      )}
    </section>
  );
}
