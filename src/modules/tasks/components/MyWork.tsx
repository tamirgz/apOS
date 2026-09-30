"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate, timeAgo } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "../core";
import type { WorkData } from "../queries";
import type { TaskStatus } from "../schema";
import { PRIORITY_META, STATUS_META, displayTitle, plainTitle } from "../states";
import { type Flags } from "./Board";
import { PriorityGlyph, StateGlyph, Who, botOwned, isClosed, splitTitle } from "./work-ui";
import { writePref } from "./prefs";

const DAY = 86_400_000;
const PROJECT_COLORS = ["var(--color-plasma)", "var(--color-ion)", "var(--color-violet)", "var(--color-solar)", "var(--color-orchid)", "var(--color-gold)"];
const ROW_CAP = 40;
const NEXT_CAP = 10;
const COLLAPSED_KEY = "work.mywork.collapsed";
/** Open work by project: the states drawn, in bar order. */
const LOAD_STATES: TaskStatus[] = ["review", "doing", "todo", "backlog"];

const dayStart = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

type GroupKey = "overdue" | "today" | "week" | "review" | "flight" | "next";
interface Group {
  key: GroupKey;
  name: string;
  hint: string;
  color: string;
  rows: WorkItem[];
  /** Rows shown before "Show all N". */
  cap: number;
}

/** "3d late" / "today" / "tomorrow" / "in 4d" / "Oct 12". */
function relDue(dueAt: Date | string, today: number): { text: string; tone: "late" | "soon" | "ok" } {
  const diff = Math.round((dayStart(+new Date(dueAt)) - today) / DAY);
  if (diff < 0) return { text: `${-diff}d late`, tone: "late" };
  if (diff === 0) return { text: "today", tone: "soon" };
  if (diff === 1) return { text: "tomorrow", tone: "soon" };
  if (diff <= 7) return { text: `in ${diff}d`, tone: "ok" };
  return { text: shortDate(dueAt), tone: "ok" };
}

/**
 * Everything on your plate across every project: what's overdue or due soon,
 * what's waiting on your review, what's in flight, and what's up next — with
 * where the open work sits, how fast it's closing, and what's waiting on
 * someone (or something) else.
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

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore remembered groups after hydration (localStorage is client-only)
      if (Array.isArray(v)) setCollapsed(new Set(v.filter((x) => typeof x === "string")));
    } catch {
      /* private mode or bad JSON — everything open */
    }
  }, []);
  const setOpen = (key: string, open: boolean) => {
    const next = new Set(collapsed);
    if (open) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    writePref(COLLAPSED_KEY, JSON.stringify([...next]));
  };
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());

  const open = data.items.filter((t) => !isClosed(t.status));
  const due = (t: WorkItem) => (t.dueAt ? dayStart(+new Date(t.dueAt)) : null);
  const rank = (t: WorkItem) => PRIORITY_META[t.priority].rank;
  const byDue = (a: WorkItem, b: WorkItem) => (due(a) ?? Infinity) - (due(b) ?? Infinity) || rank(a) - rank(b);
  const byRank = (a: WorkItem, b: WorkItem) => rank(a) - rank(b) || +new Date(b.updatedAt) - +new Date(a.updatedAt);

  const overdue = open.filter((t) => (due(t) ?? Infinity) < today).sort(byDue);
  const dueToday = open.filter((t) => due(t) === today).sort(byDue);
  const week = open
    .filter((t) => {
      const d = due(t);
      return d != null && d > today && d <= today + 7 * DAY;
    })
    .sort(byDue);
  const listed = new Set([...overdue, ...dueToday, ...week].map((t) => t.id));
  const review = open.filter((t) => t.status === "review" && !listed.has(t.id)).sort(byRank);
  const flight = open.filter((t) => t.status === "doing" && !listed.has(t.id)).sort(byRank);
  const todo = open.filter((t) => t.status === "todo" && !listed.has(t.id)).sort(byRank);

  const groups: Group[] = [
    { key: "overdue", name: "Overdue", hint: "past their due date", color: "var(--color-flare)", rows: overdue, cap: ROW_CAP },
    { key: "today", name: "Today", hint: "due today", color: "var(--color-solar)", rows: dueToday, cap: ROW_CAP },
    { key: "week", name: "This week", hint: "due in the next 7 days", color: "var(--color-ion)", rows: week, cap: ROW_CAP },
    { key: "review", name: "In review", hint: "waiting on your review", color: STATUS_META.review.color, rows: review, cap: ROW_CAP },
    { key: "flight", name: "In flight", hint: "in progress", color: STATUS_META.doing.color, rows: flight, cap: ROW_CAP },
    { key: "next", name: "Up next", hint: "highest-priority todo", color: STATUS_META.todo.color, rows: todo, cap: NEXT_CAP },
  ];

  // Where the open work sits: points when estimated, otherwise item counts — split by state.
  const usePts = open.some((t) => t.estimate != null);
  const weight = (t: WorkItem) => (usePts ? (t.estimate ?? 0) : 1);
  const load = new Map<string, { total: number; by: Partial<Record<TaskStatus, number>> }>();
  for (const t of open) {
    const k = t.projectRef ?? "";
    const cur = load.get(k) ?? { total: 0, by: {} };
    cur.total += weight(t);
    cur.by[t.status] = (cur.by[t.status] ?? 0) + weight(t);
    load.set(k, cur);
  }
  const loadRows = [...load.entries()].filter(([, v]) => v.total > 0).sort((a, b) => b[1].total - a[1].total);
  const max = Math.max(1, ...loadRows.map(([, v]) => v.total));
  const colorOf = new Map(loadRows.map(([ref], i) => [ref, PROJECT_COLORS[i % PROJECT_COLORS.length]]));
  const multiProject = new Set(open.map((t) => t.projectRef ?? "")).size > 1;

  // Throughput: items closed per day over the last two weeks.
  const closed = Array.from({ length: 14 }, (_, i) => ({ day: today - (13 - i) * DAY, n: 0 }));
  for (const t of data.items) {
    if (t.status !== "done" || !t.completedAt) continue;
    const i = 13 - Math.round((today - dayStart(+new Date(t.completedAt))) / DAY);
    if (i >= 0 && i < 14) closed[i].n++;
  }
  const closedTotal = closed.reduce((n, d) => n + d.n, 0);
  const closedMax = Math.max(1, ...closed.map((d) => d.n));

  // Waiting on others: blocked items, and Workbench runs waiting for you.
  const waiting = [
    ...open.filter((t) => flags.blocked.has(t.id)).map((t) => ({ t, why: `blocked by ${flags.blockerOf.get(t.id) ?? "an open item"}`, you: false })),
    ...open
      .filter((t) => botOwned(flags.delegated[t.id]))
      .map((t) => ({
        t,
        why: flags.delegated[t.id] === "needs_input" ? "run needs your input" : `run ${flags.delegated[t.id].replace(/_/g, " ")}`,
        you: flags.delegated[t.id] === "needs_input",
      })),
  ];

  const jump = (key: string) => {
    setOpen(key, true);
    requestAnimationFrame(() => document.getElementById(`mw-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const row = (t: WorkItem) => {
    const { text } = splitTitle(displayTitle(t));
    const rd = t.dueAt ? relDue(t.dueAt, today) : null;
    return (
      <li key={t.id}>
        <button
          type="button"
          onClick={() => onOpen(t.id)}
          title={plainTitle(t.title)}
          aria-pressed={selectedId === t.id}
          className={cn(
            "wk-row",
            multiProject
              ? "!grid-cols-[18px_76px_16px_minmax(0,1fr)_auto_72px_20px] max-md:!grid-cols-[18px_64px_minmax(0,1fr)_20px]"
              : "!grid-cols-[18px_76px_16px_minmax(0,1fr)_72px_20px] max-md:!grid-cols-[18px_64px_minmax(0,1fr)_20px]",
            selectedId === t.id && "sel",
          )}
        >
          <PriorityGlyph p={t.priority} />
          <span className="truncate font-mono text-[12px] text-ink-faint">{t.identifier}</span>
          <span className="wk-hide-sm">
            <StateGlyph s={t.status} />
          </span>
          <span dir="auto" className="truncate text-ink">
            {text}
          </span>
          {multiProject && (
            <span className="wk-hide-sm flex min-w-0 max-w-44 items-center gap-1.5">
              <i className="inline-block size-2 shrink-0 rounded-full" style={{ background: colorOf.get(t.projectRef ?? "") ?? "var(--color-ink-faint)" }} />
              <span className="truncate text-[12px] text-ink-dim">{t.projectRef ? projectName.get(t.projectRef) : "No project"}</span>
            </span>
          )}
          <span className="wk-hide-sm text-right">
            {rd && (
              <span
                className={cn("wk-due", rd.tone === "late" && "late", rd.tone === "soon" && "soon")}
                title={`Due ${new Date(t.dueAt!).toDateString()}`}
              >
                {rd.text}
              </span>
            )}
          </span>
          <Who bot={botOwned(flags.delegated[t.id])} />
        </button>
      </li>
    );
  };

  const nothing = groups.every((g) => !g.rows.length);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
        {[...groups.filter((g) => g.key !== "next"), null].map((g) => {
          const key = g ? g.key : "waiting";
          const n = g ? g.rows.length : waiting.length;
          const color = g ? g.color : "var(--color-ink-dim)";
          return (
            <button
              key={key}
              type="button"
              onClick={() => jump(key)}
              disabled={n === 0}
              className="glass flex flex-col gap-1.5 rounded-xl px-3.5 py-3 text-left transition hover:border-ion/25 disabled:cursor-default disabled:opacity-55"
            >
              <span className="flex items-center gap-1.5 text-[12px] text-ink-dim">
                <i className="inline-block size-2 rounded-full" style={{ background: color }} />
                {g ? g.name : "Waiting"}
              </span>
              <span className="font-display text-[26px] leading-none tabular-nums" style={{ color: n > 0 && key === "overdue" ? color : "var(--color-ink)" }}>
                {n}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          {groups.map((g) => {
            if (!g.rows.length) return null;
            const isOpen = !collapsed.has(g.key);
            const rows = showAll.has(g.key) ? g.rows : g.rows.slice(0, g.cap);
            return (
              <section key={g.key} id={`mw-${g.key}`} className="scroll-mt-24">
                <button
                  type="button"
                  onClick={() => setOpen(g.key, !isOpen)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition hover:bg-ink/[0.03]"
                >
                  <ChevronRight className={cn("size-3.5 text-ink-faint transition-transform", isOpen && "rotate-90")} />
                  <i className="inline-block size-2 rounded-full" style={{ background: g.color }} />
                  <span className={cn("text-[13px] font-semibold", g.key === "overdue" ? "text-flare" : "text-ink")}>{g.name}</span>
                  <span className="font-mono text-[11.5px] tabular-nums text-ink-faint">
                    {g.rows.length}
                  </span>
                  <span className="text-[11.5px] text-ink-faint">· {g.hint}</span>
                </button>
                {isOpen && (
                  <ul className="mt-0.5 flex flex-col">
                    {rows.map(row)}
                    {rows.length < g.rows.length && (
                      <li>
                        <button
                          type="button"
                          onClick={() => setShowAll(new Set(showAll).add(g.key))}
                          className="px-2 py-1.5 text-[12px] text-ink-faint transition hover:text-ink"
                        >
                          Show all {g.rows.length}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            );
          })}
          {nothing && (
            <p className="glass rounded-2xl px-5 py-8 text-center text-sm text-ink-faint">
              Nothing is due, in review, in flight or planned. Give items a due date (<span className="font-mono">@fri</span> when you create one)
              or move one to Todo to see it here.
            </p>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <section aria-label="Open work by project" className="glass flex flex-col gap-3 rounded-2xl p-4">
            <h3 className="wk-sec-h">Open {usePts ? "points" : "items"} by project</h3>
            {loadRows.length ? (
              <div className="flex flex-col gap-2.5">
                {loadRows.slice(0, 8).map(([ref, v]) => (
                  <div key={ref || "none"} className="wk-load">
                    <span dir="auto" className="flex min-w-0 items-center gap-1.5 text-ink-dim">
                      <i className="inline-block size-2 shrink-0 rounded-full" style={{ background: colorOf.get(ref) }} />
                      <span className="truncate">{ref ? (projectName.get(ref) ?? "—") : "No project"}</span>
                    </span>
                    <span
                      className="wk-bar !h-1.5"
                      title={LOAD_STATES.filter((st) => v.by[st]).map((st) => `${v.by[st]} ${STATUS_META[st].label}`).join(" · ")}
                    >
                      {LOAD_STATES.map((st) =>
                        v.by[st] ? <b key={st} style={{ width: `${(v.by[st]! / max) * 100}%`, background: STATUS_META[st].color }} /> : null,
                      )}
                    </span>
                    <em className="text-right font-mono text-[11.5px] not-italic tabular-nums text-ink-dim">{v.total}</em>
                  </div>
                ))}
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                  {LOAD_STATES.map((st) => (
                    <span key={st} className="inline-flex items-center gap-1">
                      <i className="inline-block size-2 rounded-[2px]" style={{ background: STATUS_META[st].color }} />
                      {STATUS_META[st].label}
                    </span>
                  ))}
                </p>
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-faint">No open work.</p>
            )}
          </section>

          <section aria-label="Closed per day" className="glass flex flex-col gap-2.5 rounded-2xl p-4">
            <div className="flex items-baseline gap-2">
              <h3 className="wk-sec-h">Closed per day</h3>
              <span className="ml-auto text-[11.5px] tabular-nums text-ink-faint">
                {closedTotal} in 14 days · {(closedTotal / 14).toFixed(1).replace(/\.0$/, "")}/day
              </span>
            </div>
            <div className="flex h-16 items-end gap-[3px]" role="img" aria-label={`${closedTotal} items closed in the last 14 days`}>
              {closed.map((d, i) => (
                <span
                  key={d.day}
                  className="min-w-0 flex-1 rounded-t-[3px]"
                  style={{
                    height: d.n ? `${Math.max(8, (d.n / closedMax) * 100)}%` : "2px",
                    background: d.n ? (i === 13 ? "var(--color-plasma)" : "color-mix(in oklab, var(--color-plasma) 55%, transparent)") : "color-mix(in oklab, var(--color-ink) 12%, transparent)",
                  }}
                  title={`${new Date(d.day).toDateString()}: ${d.n} closed`}
                />
              ))}
            </div>
            <div className="flex justify-between font-mono text-[10.5px] tabular-nums text-ink-faint">
              <span>{shortDate(new Date(closed[0].day))}</span>
              <span>today</span>
            </div>
          </section>

          <section id="mw-waiting" aria-label="Waiting on others" className="glass flex scroll-mt-24 flex-col gap-2 rounded-2xl p-4">
            <h3 className="wk-sec-h">
              Waiting on others <span className="tabular-nums">{waiting.length}</span>
            </h3>
            {waiting.length ? (
              <ul className="-mx-1.5 flex flex-col">
                {waiting.slice(0, 12).map(({ t, why, you }) => (
                  <li key={`${t.id}:${why}`}>
                    <button
                      type="button"
                      onClick={() => onOpen(t.id)}
                      className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] text-ink-dim transition hover:bg-ink/5"
                    >
                      <b className="shrink-0 font-mono text-[11.5px] font-medium text-ink">{t.identifier}</b>
                      <span className={cn("truncate", you && "text-solar")}>{why}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-faint">{timeAgo(t.updatedAt, { compact: true })}</span>
                    </button>
                  </li>
                ))}
                {waiting.length > 12 && <li className="px-1.5 pt-1 text-[11.5px] text-ink-faint">+ {waiting.length - 12} more</li>}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ink-faint">Nothing is blocked or waiting on a Workbench run.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
