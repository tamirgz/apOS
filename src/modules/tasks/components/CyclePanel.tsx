"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { done, errorText } from "@/core/ui/feedback";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import {
  createCycleAction,
  deleteCycleAction,
  rollOverCycleAction,
  updateCycleAction,
} from "../actions";
import type { CycleStatus, CycleSummary } from "../cycles";
import type { WorkItem } from "../core";
import type { WorkProject } from "../queries";
import { cycleMetrics, fmtRate, type CycleMetrics } from "../stats";
import { Burn, CycleBar } from "./cycle-kit";

const DAY = 86_400_000;

export const CYCLE_META: Record<CycleStatus, { label: string; color: string }> = {
  current: { label: "Current", color: "var(--color-ion)" },
  upcoming: { label: "Upcoming", color: "var(--color-ink-faint)" },
  completed: { label: "Completed", color: "var(--color-plasma)" },
};

/** "3 items moved to Cycle 5" / "3 items moved to the backlog". */
function rolledOver(n: number, next: { name: string } | null) {
  return `${n} item${n === 1 ? "" : "s"} moved to ${next ? next.name : "the backlog"}`;
}

export const dateInput = (d: Date | string | number) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

function CycleForm({
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  initial: { name: string; startsAt: string; endsAt: string };
  onSubmit: (v: { name: string; startsAt: string; endsAt: string }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [v, setV] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
      className="glass flex flex-wrap items-center gap-2 rounded-2xl p-2.5"
    >
      <input
        autoFocus
        dir="auto"
        value={v.name}
        onChange={(e) => setV({ ...v, name: e.target.value })}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Cycle name — e.g. Sprint 15"
        aria-label="Cycle name"
        className="h-8 min-w-40 flex-1 rounded-lg bg-ink/5 px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <input
        type="date"
        value={v.startsAt}
        onChange={(e) => setV({ ...v, startsAt: e.target.value })}
        aria-label="Starts"
        className="rounded-lg border border-ion/12 bg-transparent px-2 py-1.5 text-xs text-ink-dim outline-none"
      />
      <ArrowRight className="size-3 text-ink-faint" />
      <input
        type="date"
        value={v.endsAt}
        onChange={(e) => setV({ ...v, endsAt: e.target.value })}
        aria-label="Ends"
        className="rounded-lg border border-ion/12 bg-transparent px-2 py-1.5 text-xs text-ink-dim outline-none"
      />
      <button
        type="submit"
        disabled={pending || !v.name.trim()}
        className="wk-btn primary !py-1.5 text-xs"
      >
        Save
      </button>
      <button type="button" onClick={onCancel} className="wk-btn !py-1.5 text-xs">
        Cancel
      </button>
    </form>
  );
}


/** Pace · Risk · Scope — read off the data by rules, never a model call. */
function CycleReads({ c, m, onOpenItem }: { c: CycleSummary; m: CycleMetrics; onOpenItem?: (id: string) => void }) {
  const now = useNow();
  const link = "underline decoration-dotted underline-offset-2 transition hover:text-ink";
  const ref = (t: WorkItem) =>
    onOpenItem ? (
      <button type="button" className={link} onClick={() => onOpenItem(t.id)}>
        {t.identifier}
      </button>
    ) : (
      t.identifier
    );
  const behind = c.status === "current" && m.open > 0 && m.need > m.pace * 1.15;
  return (
    <div className="flex flex-col gap-2">
      <p className={cn("wk-read", c.status !== "upcoming" && (behind ? "flare" : "plasma"))}>
        <b>Pace</b> ·{" "}
        {c.status === "current" ? (
          m.open === 0 ? (
            "everything in the cycle is closed."
          ) : (
            <>
              {m.open} open with {m.daysLeft} day{m.daysLeft === 1 ? "" : "s"} left — needs ~{fmtRate(m.need)}/day against a recent{" "}
              {fmtRate(m.pace)}/day{behind ? ", so it won't finish at this rate." : ", on track."}
            </>
          )
        ) : c.status === "upcoming" ? (
          <>
            starts in {Math.max(1, Math.ceil((+new Date(c.startsAt) - now) / DAY))}d with {m.open} item{m.open === 1 ? "" : "s"} planned
            {m.pace > 0 && m.open > 0 && <> — about {Math.ceil(m.open / m.pace)} days of work at the recent pace</>}.
          </>
        ) : (
          <>
            finished {m.pct}% ({m.by.done} of {m.total} {m.unit}){m.open > 0 && `, ${m.open} left over`}.
          </>
        )}
      </p>
      {c.status !== "completed" && (
        <p className={m.overdue.length || m.blocked.length ? "wk-read flare" : "wk-read plasma"}>
          <b>Risk</b> ·{" "}
          {m.overdue.length || m.blocked.length ? (
            <>
              {m.overdue.length > 0 && (
                <>
                  {m.overdue.length} overdue ({ref(m.overdue[0])})
                </>
              )}
              {m.overdue.length > 0 && m.blocked.length > 0 && " · "}
              {m.blocked.length > 0 && (
                <>
                  {m.blocked.length} blocked ({ref(m.blocked[0])})
                </>
              )}
              .
            </>
          ) : (
            "nothing in it is overdue or blocked."
          )}
          {m.by.review > 0 && ` ${m.by.review} ${m.unit} waiting in review.`}
        </p>
      )}
      <p className={m.scopeGrew > 0 ? "wk-read" : "wk-read plasma"}>
        <b>Scope</b> ·{" "}
        {m.scopeGrew > 0
          ? `grew by ${m.scopeGrew} item${m.scopeGrew === 1 ? "" : "s"} after it started — the burndown steps up where it did.`
          : c.status === "upcoming"
            ? "not started, so no change yet."
            : "unchanged since it started."}
      </p>
    </div>
  );
}

function StatusChip({ c }: { c: CycleSummary }) {
  return (
    <span className="wk-chip" style={{ color: CYCLE_META[c.status].color }}>
      <i className="dot" />
      {CYCLE_META[c.status].label}
    </span>
  );
}

/** Edit / delete / roll-over state shared by the hero and the cards. */
function useCycleOps(c: CycleSummary, next: CycleSummary | null, onDeleted?: () => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [rollArmed, setRollArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<T>, after?: (r: T) => void) =>
    start(async () => {
      setError(null);
      try {
        after?.(await fn());
        router.refresh();
      } catch (e) {
        setError(errorText(e));
      }
    });
  return {
    rollArmed,
    /** Rolling a cycle that's still running moves live work, so it asks twice. */
    armRollOver: () => {
      if (rollArmed) {
        setRollArmed(false);
        run(() => rollOverCycleAction(c.id, next?.id ?? null), (n) => done(rolledOver(n, next)));
        return;
      }
      setRollArmed(true);
      setTimeout(() => setRollArmed(false), 3500);
    },
    pending,
    editing,
    setEditing,
    armed,
    error,
    form: (
      <CycleForm
        initial={{ name: c.name, startsAt: dateInput(c.startsAt), endsAt: dateInput(c.endsAt) }}
        pending={pending}
        onCancel={() => setEditing(false)}
        onSubmit={(v) => run(async () => (await updateCycleAction(c.id, v), setEditing(false)))}
      />
    ),
    remove: () => {
      if (!armed) {
        setArmed(true);
        setTimeout(() => setArmed(false), 3000);
        return;
      }
      run(() => deleteCycleAction(c.id), onDeleted);
    },
    rollOver: () => run(() => rollOverCycleAction(c.id, next?.id ?? null), (n) => done(rolledOver(n, next))),
  };
}

/**
 * One cycle, big: status, span and days left, % done with the segmented bar,
 * a full-width burndown, and the rules-based read. The Cycles tab leads with
 * the running cycle in this form; a cycle's own page uses it as its header.
 */
function CycleHero({
  c,
  items,
  blocked,
  next,
  projectName,
  onOpen,
  onBack,
  onOpenItem,
}: {
  c: CycleSummary;
  items: WorkItem[];
  blocked: string[];
  next: CycleSummary | null;
  projectName?: string | null;
  onOpen?: () => void;
  onBack?: () => void;
  onOpenItem?: (id: string) => void;
}) {
  const now = useNow();
  const ops = useCycleOps(c, next, onBack);
  const m = cycleMetrics(c, items, blocked, now);
  const days = Math.max(1, Math.round((+new Date(c.endsAt) - +new Date(c.startsAt)) / DAY) + 1);
  const elapsed = Math.min(days, Math.max(0, Math.floor((now - +new Date(c.startsAt)) / DAY) + 1));

  return (
    <section aria-label={c.name} className={cn("glass flex flex-col gap-4 rounded-2xl p-5", ops.pending && "opacity-70")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onBack && (
          <button type="button" onClick={onBack} className="wk-btn !px-2 !py-1 text-xs" aria-label="Back to cycles">
            <ArrowLeft className="size-3.5" /> Cycles
          </button>
        )}
        <StatusChip c={c} />
        {onOpen ? (
          <button type="button" onClick={onOpen} dir="auto" className="font-display text-[22px] leading-tight text-ink transition hover:text-plasma">
            {c.name}
          </button>
        ) : (
          <h2 dir="auto" className="font-display text-[22px] leading-tight text-ink">
            {c.name}
          </h2>
        )}
        <span className="font-mono text-xs tabular-nums text-ink-faint">
          {shortDate(c.startsAt)} – {shortDate(c.endsAt)}
          {c.status === "current" && ` · ${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"} left`}
          {c.status === "completed" && " · ended"}
        </span>
        {projectName && <span className="wk-pill">{projectName}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => ops.setEditing((v) => !v)} className="wk-btn !py-1 text-xs">
            <Pencil className="size-3.5" /> Edit
          </button>
          {c.status === "current" && m.open > 0 && (
            <button
              type="button"
              onClick={ops.armRollOver}
              className={cn("wk-btn !py-1 text-xs", ops.rollArmed && "!border-solar/50 text-solar")}
              title={`Move the ${m.open} unfinished item${m.open === 1 ? "" : "s"} to ${next ? next.name : "the backlog"}`}
            >
              <RefreshCw className="size-3.5" />
              {ops.rollArmed ? `Click again to move ${m.open} to ${next ? next.name : "the backlog"}` : "Roll over"}
            </button>
          )}
          <button
            type="button"
            onClick={ops.remove}
            className={cn("wk-btn !py-1 text-xs", ops.armed ? "!border-flare/50 text-flare" : "!px-2 text-ink-faint hover:text-flare")}
            title="Delete cycle (its items stay, just un-planned)"
            aria-label={`Delete ${c.name}`}
          >
            <Trash2 className="size-3.5" />
            {ops.armed && "Click again to delete"}
          </button>
        </span>
      </header>

      {ops.editing && ops.form}

      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.6fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <div className="mb-2 flex items-baseline gap-2.5">
              <span className="font-display text-[44px] leading-none tabular-nums text-ink">{m.pct}%</span>
              <span className="text-[13px] tabular-nums text-ink-dim">
                of {m.total} {m.unit} done
              </span>
            </div>
            <CycleBar m={m} big />
          </div>
          <CycleReads c={c} m={m} onOpenItem={onOpenItem} />
        </div>

        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-3 text-xs text-ink-faint">
            <span className="wk-sec-h">Burndown</span>
            {c.status === "current" && (
              <span className="tabular-nums">
                day {elapsed} of {days}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-1.5">
              <i className="inline-block h-0.5 w-3.5 rounded bg-plasma" /> open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block w-3.5 border-t border-dashed border-ink/35" /> ideal
            </span>
          </div>
          {c.burndown.length ? (
            <Burn c={c} height={170} className="rounded-lg" />
          ) : (
            <div className="grid h-[170px] place-items-center rounded-lg border border-dashed border-ion/15 text-xs text-ink-faint">
              The line starts on {shortDate(c.startsAt)}.
            </div>
          )}
          <div className="mt-1.5 flex justify-between font-mono text-[11px] tabular-nums text-ink-faint">
            <span>{shortDate(c.startsAt)}</span>
            <span>{shortDate(c.endsAt)}</span>
          </div>
        </div>
      </div>

      {c.status === "completed" && m.open > 0 && (
        <p className="flex flex-wrap items-center gap-2 border-t border-ion/10 pt-3 text-[13px] text-ink-dim">
          {m.open} item{m.open === 1 ? "" : "s"} didn&apos;t finish.
          <button type="button" onClick={ops.rollOver} className="wk-btn primary !py-1 text-xs">
            <RefreshCw className="size-3.5" />
            {next ? `Move to ${next.name}` : "Un-plan them"}
          </button>
        </p>
      )}
      {ops.error && <p className="text-xs text-flare">{ops.error}</p>}
    </section>
  );
}

/** A cycle that isn't running: glyph, name, span, a mini burndown, and progress. */
function CycleCard({
  c,
  items,
  next,
  projectName,
  onSelect,
}: {
  c: CycleSummary;
  items: WorkItem[];
  next: CycleSummary | null;
  projectName: string | null;
  onSelect: () => void;
}) {
  const now = useNow();
  const ops = useCycleOps(c, next);
  const m = cycleMetrics(c, items, [], now);
  if (ops.editing) return ops.form;
  const startsIn = Math.max(1, Math.ceil((+new Date(c.startsAt) - now) / DAY));

  return (
    <article className={cn("wk-card group !gap-2.5 !p-3.5", ops.pending && "opacity-50")}>
      <div className="flex items-start gap-2">
        <i className="mt-[5px] inline-block size-2 shrink-0 rounded-full" style={{ background: CYCLE_META[c.status].color }} aria-hidden />
        <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" title="Open this cycle">
          <span dir="auto" className="block truncate font-display text-[15px] text-ink transition group-hover:text-plasma">
            {c.name}
          </span>
          <span className="block font-mono text-[11px] tabular-nums text-ink-faint">
            {shortDate(c.startsAt)} – {shortDate(c.endsAt)}
            {c.status === "upcoming" && ` · in ${startsIn}d`}
            {projectName && ` · ${projectName}`}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button type="button" onClick={() => ops.setEditing(true)} className="rounded-md p-1 text-ink-faint hover:text-ink" aria-label={`Edit ${c.name}`}>
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={ops.remove}
            className={cn("flex items-center gap-1 rounded-md p-1 text-xs", ops.armed ? "text-flare" : "text-ink-faint hover:text-flare")}
            aria-label={`Delete ${c.name}`}
            title="Delete cycle (its items stay, just un-planned)"
          >
            <Trash2 className="size-3.5" />
            {ops.armed && "again"}
          </button>
        </span>
      </div>
      <button type="button" onClick={onSelect} tabIndex={-1} aria-hidden className="block">
        {c.burndown.length ? (
          <Burn c={c} height={40} />
        ) : (
          <div className="grid h-10 place-items-center rounded-md border border-dashed border-ion/12 text-[11px] text-ink-faint">
            {m.total ? `${m.total} ${m.unit} planned` : "nothing planned yet"}
          </div>
        )}
      </button>
      <div className="wk-bar" aria-hidden>
        {m.total > 0 && <b style={{ width: `${m.pct}%`, background: "var(--color-plasma)" }} />}
      </div>
      <div className="flex items-center gap-2 text-xs tabular-nums text-ink-dim">
        <span className="text-ink">{m.pct}%</span>
        <span>
          {c.done}/{c.total} items{c.points ? ` · ${c.pointsDone}/${c.points} pts` : ""}
        </span>
        {c.status === "completed" && m.open > 0 && (
          <button
            type="button"
            onClick={ops.rollOver}
            className="ml-auto inline-flex items-center gap-1 text-plasma transition hover:text-ink"
            title={`Move the ${m.open} unfinished item${m.open === 1 ? "" : "s"} to ${next ? next.name : "the backlog"}`}
          >
            <RefreshCw className="size-3" />
            {m.open} left · {next ? "roll over" : "un-plan"}
          </button>
        )}
      </div>
      {ops.error && <p className="text-xs text-flare">{ops.error}</p>}
    </article>
  );
}

/**
 * Cycles: the running cycle up top in full (progress, burndown, the read),
 * then upcoming and completed ones as cards. Click any cycle to open its page
 * with its items below; a finished one offers to roll its leftovers over.
 */
export function CyclesView({
  cycles,
  items,
  blocked,
  projectId,
  projects,
  onSelect,
  onOpenItem,
}: {
  cycles: CycleSummary[];
  items: WorkItem[];
  blocked: string[];
  projectId?: string;
  projects: WorkProject[];
  onSelect: (cycleId: string) => void;
  onOpenItem?: (id: string) => void;
}) {
  const router = useRouter();
  const now = useNow();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectName = new Map(projects.map((p) => [p.id, p.key ?? p.name]));
  const nameFor = (c: CycleSummary) => (!projectId && c.projectId ? (projectName.get(c.projectId) ?? null) : null);

  const byStart = (a: CycleSummary, b: CycleSummary) => +new Date(a.startsAt) - +new Date(b.startsAt);
  const current = cycles.filter((c) => c.status === "current").sort(byStart);
  const upcoming = cycles.filter((c) => c.status === "upcoming").sort(byStart);
  const completed = cycles.filter((c) => c.status === "completed").sort((a, b) => byStart(b, a));

  // Default a new cycle to start the day after the latest one ends (or today), two weeks long.
  const latestEnd = Math.max(0, ...cycles.map((c) => +new Date(c.endsAt)));
  const startDefault = latestEnd > now ? latestEnd + DAY : now;
  const n = cycles.length + 1;

  const grid = (list: CycleSummary[]) => (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
      {list.map((c) => (
        <CycleCard key={c.id} c={c} items={items} next={nextCycleFor(cycles, c)} projectName={nameFor(c)} onSelect={() => onSelect(c.id)} />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-ink-faint">
          {projectId ? "This project's cycles, plus cross-project ones." : "Every cycle. Items join one from their drawer."}
        </p>
        <button type="button" onClick={() => setAdding((v) => !v)} className="wk-btn primary ml-auto !py-1.5 text-xs">
          <Plus className="size-3.5" /> New cycle
        </button>
      </div>
      {adding && (
        <CycleForm
          initial={{ name: `Cycle ${n}`, startsAt: dateInput(startDefault), endsAt: dateInput(startDefault + 13 * DAY) }}
          pending={pending}
          onCancel={() => setAdding(false)}
          onSubmit={(v) =>
            start(async () => {
              setError(null);
              try {
                await createCycleAction({ ...v, projectId: projectId ?? null });
                setAdding(false);
                router.refresh();
              } catch (e) {
                setError(errorText(e));
              }
            })
          }
        />
      )}
      {error && <p className="text-xs text-flare">{error}</p>}

      {cycles.length === 0 && !adding && (
        <div className="glass flex flex-col items-center gap-3 rounded-2xl px-6 py-10 text-center">
          <p className="max-w-md text-sm text-ink-dim">
            No cycles yet. A cycle is a time-box — usually one or two weeks — you plan items into, so you can see whether you&apos;ll finish
            them.
          </p>
          <button type="button" onClick={() => setAdding(true)} className="wk-btn primary text-xs">
            <Plus className="size-3.5" /> Plan the first cycle
          </button>
        </div>
      )}

      {current.map((c) => (
        <CycleHero
          key={c.id}
          c={c}
          items={items}
          blocked={blocked}
          next={nextCycleFor(cycles, c)}
          projectName={nameFor(c)}
          onOpen={() => onSelect(c.id)}
          onOpenItem={onOpenItem}
        />
      ))}
      {cycles.length > 0 && current.length === 0 && (
        <p className="glass rounded-2xl px-5 py-4 text-[13px] text-ink-dim">
          No cycle is running right now.{" "}
          {upcoming[0] ? (
            <>
              <button type="button" onClick={() => onSelect(upcoming[0].id)} className="text-ink underline decoration-dotted underline-offset-2">
                {upcoming[0].name}
              </button>{" "}
              starts {shortDate(upcoming[0].startsAt)}.
            </>
          ) : (
            "Plan the next one to get a burndown and a pace read."
          )}
        </p>
      )}

      {upcoming.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="wk-sec-h">
            Upcoming <span className="tabular-nums">{upcoming.length}</span>
          </h3>
          {grid(upcoming)}
        </section>
      )}
      {completed.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="wk-sec-h">
            Completed <span className="tabular-nums">{completed.length}</span>
          </h3>
          {grid(completed)}
        </section>
      )}
    </div>
  );
}

/** A cycle's page header: the same hero the Cycles tab leads with, plus a way back. Its items render below. */
export function CycleHeader({
  c,
  items,
  blocked,
  next,
  onBack,
  onOpenItem,
}: {
  c: CycleSummary;
  items: WorkItem[];
  blocked: string[];
  next: CycleSummary | null;
  onBack: () => void;
  onOpenItem?: (id: string) => void;
}) {
  return <CycleHero c={c} items={items} blocked={blocked} next={next} onBack={onBack} onOpenItem={onOpenItem} />;
}

/** The cycle a finished one would roll its leftovers into: the next unfinished one in the same scope. */
export function nextCycleFor(cycles: CycleSummary[], c: CycleSummary): CycleSummary | null {
  return (
    cycles
      .filter((o) => o.id !== c.id && o.status !== "completed" && (o.projectId ?? null) === (c.projectId ?? null))
      .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0] ?? null
  );
}
