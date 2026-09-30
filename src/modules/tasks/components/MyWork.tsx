"use client";

import { useMemo } from "react";
import { cn } from "@/core/ui/cn";
import { timeAgo } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "../core";
import type { WorkData } from "../queries";
import { PRIORITY_META, displayTitle, plainTitle } from "../states";
import { type Flags } from "./Board";
import { Due, PriorityGlyph, StateGlyph, Who, botOwned, isClosed, splitTitle } from "./work-ui";

const DAY = 86_400_000;
const PROJECT_COLORS = ["var(--color-plasma)", "var(--color-ion)", "var(--color-violet)", "var(--color-solar)", "var(--color-orchid)", "var(--color-gold)"];

const dayStart = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

/**
 * Everything on your plate across every project: overdue, due today, due this
 * week, and what's already in flight — plus where the open work sits and
 * what is waiting on someone (or something) else.
 */
export function MyWork({
  data,
  flags,
  selectedId,
  onOpen,
}: {
  data: WorkData;
  flags: Flags;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const now = useNow();
  const today = dayStart(now);
  const projectName = useMemo(() => new Map(data.projects.map((p) => [`projects:${p.id}`, p.name])), [data.projects]);
  const open = data.items.filter((t) => !isClosed(t.status));
  const due = (t: WorkItem) => (t.dueAt ? dayStart(+new Date(t.dueAt)) : null);
  const byPri = (a: WorkItem, b: WorkItem) =>
    (due(a) ?? Infinity) - (due(b) ?? Infinity) || PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank;

  const overdue = open.filter((t) => (due(t) ?? Infinity) < today).sort(byPri);
  const dueToday = open.filter((t) => due(t) === today).sort(byPri);
  const week = open.filter((t) => {
    const d = due(t);
    return d != null && d > today && d <= today + 7 * DAY;
  }).sort(byPri);
  const listed = new Set([...overdue, ...dueToday, ...week].map((t) => t.id));
  const inFlight = open
    .filter((t) => (t.status === "doing" || t.status === "review") && !listed.has(t.id))
    .sort((a, b) => PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank);

  const groups = [
    { name: "Overdue", rows: overdue, tone: "text-flare" },
    { name: "Today", rows: dueToday, tone: "" },
    { name: "This week", rows: week, tone: "" },
    { name: "In flight", rows: inFlight, tone: "" },
  ];

  // Where the open work sits: points when estimated, otherwise item counts.
  const usePts = open.some((t) => t.estimate != null);
  const load = new Map<string, number>();
  for (const t of open) {
    const k = t.projectRef ?? "";
    load.set(k, (load.get(k) ?? 0) + (usePts ? (t.estimate ?? 0) : 1));
  }
  const loadRows = [...load.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...loadRows.map(([, v]) => v));

  // Waiting on others: blocked items, and Workbench runs waiting for you.
  const waiting = [
    ...open.filter((t) => flags.blocked.has(t.id)).map((t) => ({ t, why: `blocked by ${flags.blockerOf.get(t.id) ?? "an open item"}` })),
    ...open
      .filter((t) => botOwned(flags.delegated[t.id]))
      .map((t) => ({ t, why: flags.delegated[t.id] === "needs_input" ? "run needs your input" : `run ${flags.delegated[t.id]}` })),
  ].slice(0, 8);

  const row = (t: WorkItem) => {
    const { text } = splitTitle(displayTitle(t));
    return (
      <li key={t.id}>
        <button
          type="button"
          onClick={() => onOpen(t.id)}
          title={plainTitle(t.title)}
          aria-pressed={selectedId === t.id}
          className={cn("wk-row !grid-cols-[18px_76px_16px_minmax(0,1fr)_auto_60px_20px] max-md:!grid-cols-[18px_64px_minmax(0,1fr)_20px]", selectedId === t.id && "sel")}
        >
          <PriorityGlyph p={t.priority} />
          <span className="truncate font-mono text-[12px] text-ink-faint">{t.identifier}</span>
          <span className="wk-hide-sm">
            <StateGlyph s={t.status} />
          </span>
          <span dir="auto" className="truncate text-ink">
            {text}
          </span>
          <span className="wk-hide-sm min-w-0 max-w-40">
            <span className="wk-pill block">{t.projectRef ? projectName.get(t.projectRef) : "No project"}</span>
          </span>
          <span className="wk-hide-sm">
            <Due item={t} now={now} />
          </span>
          <Who bot={botOwned(flags.delegated[t.id])} />
        </button>
      </li>
    );
  };

  return (
    <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-3.5">
        {groups.map((g) =>
          g.rows.length ? (
            <section key={g.name}>
              <h5 className={cn("mb-1 flex items-center gap-2 px-1 py-1.5 text-[12.5px] font-semibold text-ink-dim", g.tone)}>
                {g.name} <span className="font-mono font-normal text-ink-faint">{g.rows.length}</span>
              </h5>
              <ul className="flex flex-col">{g.rows.slice(0, 40).map(row)}</ul>
            </section>
          ) : null,
        )}
        {groups.every((g) => !g.rows.length) && (
          <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">
            Nothing is due this week and nothing is in flight. Give items a due date (<span className="font-mono">@fri</span> when you create
            one) to see them here.
          </p>
        )}
      </div>
      <aside className="flex flex-col gap-3">
        <div className="glass rounded-2xl p-3.5">
          <h6 className="mb-2 font-display text-[13.5px] font-semibold tracking-[0.03em] text-ink">
            Open {usePts ? "points" : "items"} by project
          </h6>
          <div className="flex flex-col gap-2">
            {loadRows.map(([ref, v], i) => (
              <div key={ref || "none"} className="wk-load">
                <span dir="auto" className="truncate text-ink-dim">
                  {ref ? projectName.get(ref) ?? "—" : "No project"}
                </span>
                <span className="wk-bar !h-1.5">
                  <b style={{ width: `${(v / max) * 100}%`, background: PROJECT_COLORS[i % PROJECT_COLORS.length] }} />
                </span>
                <em className="text-right font-mono text-[11.5px] not-italic tabular-nums text-ink-dim">{v}</em>
              </div>
            ))}
            {!loadRows.length && <p className="text-xs text-ink-faint">No open work.</p>}
          </div>
        </div>
        <div className="glass rounded-2xl p-3.5">
          <h6 className="mb-2 font-display text-[13.5px] font-semibold tracking-[0.03em] text-ink">Waiting on others</h6>
          {waiting.length ? (
            <ul className="flex flex-col gap-1">
              {waiting.map(({ t, why }) => (
                <li key={`${t.id}:${why}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(t.id)}
                    className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left text-[12.5px] text-ink-dim transition hover:bg-ink/5"
                  >
                    <b className="shrink-0 font-mono text-[11.5px] font-medium text-ink">{t.identifier}</b>
                    <span className="truncate">{why}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-faint">{timeAgo(t.updatedAt, { compact: true })}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-faint">Nothing is blocked or waiting on a run.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
