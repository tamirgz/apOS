"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  Ban,
  Bot,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  Columns3,
  Download,
  Gauge,
  Layers,
  List,
  Plus,
  Repeat,
  Search,
  Signal,
  Bookmark,
  X,
  Rows3,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import { createTask, deleteWorkView, moveTask, saveWorkView } from "../actions";
import type { WorkItem } from "../core";
import { parseQuick } from "../parse";
import type { WorkData } from "../queries";
import { TASK_STATUSES, type TaskPriority, type TaskStatus, type WorkView as SavedView, type WorkViewFilters } from "../schema";
import { BOARD_STATUSES, PRIORITY_META, STATUS_META, displayTitle, plainTitle } from "../states";
import { CalendarView } from "./CalendarView";
import { CycleHeader, CyclesView, nextCycleFor } from "./CyclePanel";
import { ModuleHeader, ModulesView } from "./ModulesView";
import { PlaneImport } from "./PlaneImport";
import { Timeline } from "./Timeline";
import { WorkItemDetail } from "./WorkItemDetail";
import { readPref, writePref } from "./prefs";

const DONE_WINDOW_DAYS = 14;
const BOARD_CAP = 25;
const DAY = 86_400_000;
const closed = (s: TaskStatus) => s === "done" || s === "cancelled";


function PriorityIcon({ p }: { p: TaskPriority }) {
  return (
    <Signal
      className={cn("size-3.5 shrink-0", PRIORITY_META[p].className, p === "low" && "opacity-60")}
      aria-label={`${PRIORITY_META[p].label} priority`}
    />
  );
}

function DueChip({ item }: { item: WorkItem }) {
  const now = useNow();
  if (!item.dueAt || closed(item.status)) return null;
  const due = new Date(item.dueAt);
  const days = Math.floor((due.getTime() - now) / DAY);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[10px] tabular-nums",
        days < 0 ? "text-flare" : days <= 2 ? "text-solar" : "text-ink-faint",
      )}
      title={`Due ${due.toDateString()}`}
    >
      <CalendarClock className="size-3" />
      {shortDate(due)}
    </span>
  );
}

function Labels({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <>
      {labels.slice(0, 3).map((l) => (
        <span key={l} className="rounded-md border border-white/8 px-1.5 py-px font-mono text-[9px] tracking-wide text-ink-faint">
          {l}
        </span>
      ))}
    </>
  );
}

/** Blocked by open work / handed to the Workbench — the two "why isn't this moving" signals. */
function Flags({ blocked, delegated }: { blocked?: boolean; delegated?: string }) {
  const live = delegated && delegated !== "done" && delegated !== "cancelled";
  return (
    <>
      {blocked && (
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-flare" title="Blocked by an open item">
          <Ban className="size-3" /> blocked
        </span>
      )}
      {live && (
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-violet" title={`Run: ${delegated}`}>
          <Bot className="size-3" /> {delegated === "needs_input" ? "needs input" : delegated}
        </span>
      )}
    </>
  );
}

// ── quick create ───────────────────────────────────────────────────────────

function QuickCreate({
  inputRef,
  data,
  projectId,
  featureId,
  cycleId,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  data: WorkData;
  projectId?: string;
  featureId: string | null;
  cycleId?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const parsed = parseQuick(text);
  const keyed = parsed.projectKey ? data.projects.find((p) => p.key === parsed.projectKey) : undefined;

  const submit = () => {
    if (!parsed.title) return;
    const projectRef = keyed ? `projects:${keyed.id}` : projectId ? `projects:${projectId}` : null;
    start(async () => {
      await createTask({
        title: parsed.title,
        priority: parsed.priority,
        labels: parsed.labels,
        dueAt: parsed.dueAt ?? null,
        estimate: parsed.estimate ?? null,
        status: parsed.status,
        projectRef,
        featureRef: featureId && (!keyed || keyed.id === projectId) ? `features:${featureId}` : null,
        cycleId: cycleId ?? null,
      });
      setText("");
      router.refresh();
    });
  };

  const chips = [
    parsed.status && STATUS_META[parsed.status].label,
    parsed.priority && PRIORITY_META[parsed.priority].label,
    ...parsed.labels.map((l) => `#${l}`),
    parsed.dueAt && `due ${shortDate(parsed.dueAt)}`,
    parsed.estimate != null && `${parsed.estimate} pts`,
    parsed.projectKey && (keyed ? keyed.name : `no project ${parsed.projectKey}`),
  ].filter(Boolean) as string[];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="glass flex flex-col gap-1 rounded-xl p-1.5 pl-3 focus-within:glass-edge"
    >
      <div className="flex items-center gap-2">
        <Plus className="size-4 text-plasma" />
        <input
          ref={inputRef}
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLInputElement).blur()}
          placeholder="New item… !high #label @fri ~3 +KEY >backlog   (press C)"
          aria-label="New work item"
          className="h-9 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending || !parsed.title}
          className="rounded-lg bg-plasma/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
        >
          {pending ? "…" : "add"}
        </button>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1 pl-6">
          {chips.map((c) => (
            <span key={c} className="rounded-md bg-white/6 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
              {c}
            </span>
          ))}
        </div>
      )}
    </form>
  );
}

// ── board ──────────────────────────────────────────────────────────────────

function Card({
  item,
  subCount,
  blocked,
  delegated,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropBefore,
  compact = false,
}: {
  item: WorkItem;
  compact?: boolean;
  subCount?: { done: number; total: number };
  blocked?: boolean;
  delegated?: string;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onDropBefore();
      }}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      role="button"
      tabIndex={0}
      className={cn(
        "glass group relative cursor-grab rounded-xl outline-none transition active:cursor-grabbing focus-visible:ring-1 focus-visible:ring-ion/50",
        compact ? "px-2.5 py-1.5" : "p-3",
        dragging && "opacity-30",
        over && "before:absolute before:inset-x-2 before:-top-1.5 before:h-0.5 before:rounded-full before:bg-ion",
      )}
    >
      {compact ? (
        // Compact density: one row — priority, id, one-line title, flags.
        <div className="flex items-center gap-2">
          <PriorityIcon p={item.priority} />
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{item.identifier}</span>
          <span
            dir="auto"
            title={plainTitle(item.title)}
            className={cn("min-w-0 flex-1 truncate text-xs", closed(item.status) ? "text-ink-faint line-through" : "text-ink-dim group-hover:text-ink")}
          >
            {displayTitle(item)}
          </span>
          <Flags blocked={blocked} delegated={delegated} />
        </div>
      ) : (
      <>
      <div className="mb-1.5 flex items-center gap-2">
        <PriorityIcon p={item.priority} />
        <span className="font-mono text-[10px] text-ink-faint">{item.identifier}</span>
        {item.estimate != null && (
          <span className="ml-auto rounded-md bg-white/5 px-1.5 font-mono text-[10px] tabular-nums text-ink-faint" title="Estimate">
            {item.estimate}
          </span>
        )}
      </div>
      {/* Two lines max — imported titles run to paragraphs; the full text is
          in the drawer and the tooltip. */}
      <p
        dir="auto"
        title={plainTitle(item.title)}
        className={cn("line-clamp-2 text-sm leading-snug", closed(item.status) ? "text-ink-faint line-through" : "text-ink-dim group-hover:text-ink")}
      >
        {displayTitle(item)}
      </p>
      {(item.labels.length > 0 || item.dueAt || subCount || blocked || delegated) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Flags blocked={blocked} delegated={delegated} />
          <Labels labels={item.labels} />
          {subCount && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-ink-faint" title="Sub-items">
              <Layers className="size-3" />
              {subCount.done}/{subCount.total}
            </span>
          )}
          <span className="ml-auto">
            <DueChip item={item} />
          </span>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function Board({
  items,
  all,
  flags,
  onOpen,
  onMove,
  compact = false,
}: {
  compact?: boolean;
  items: WorkItem[];
  all: WorkItem[];
  flags: { blocked: Set<string>; delegated: Record<string, string> };
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus, sortOrder: number) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);
  const [olderDone, setOlderDone] = useState(false);
  // Done is folded to a slim rail by default — finished work shouldn't take a
  // fifth of the board. Remembered per browser.
  const [doneOpen, setDoneOpen] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered choice after hydration (localStorage is client-only)
  useEffect(() => setDoneOpen(readPref("work.board.done", "closed", ["open", "closed"]) === "open"), []);
  const toggleDone = () => {
    setDoneOpen((o) => {
      writePref("work.board.done", o ? "closed" : "open");
      return !o;
    });
  };
  // Big projects (an imported backlog runs to hundreds) would render every card: cap each column.
  const [limit, setLimit] = useState<Partial<Record<TaskStatus, number>>>({});
  const now = useNow();

  const subCounts = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const t of all) {
      if (!t.parentId) continue;
      const c = m.get(t.parentId) ?? { done: 0, total: 0 };
      c.total++;
      if (closed(t.status)) c.done++;
      m.set(t.parentId, c);
    }
    return m;
  }, [all]);

  const columns = BOARD_STATUSES.map((status) => {
    let col = items.filter((t) => t.status === status).sort((a, b) => a.sortOrder - b.sortOrder);
    let hidden = 0;
    if (status === "done" && !olderDone) {
      const recent = col.filter((t) => t.completedAt && now - +new Date(t.completedAt) < DONE_WINDOW_DAYS * DAY);
      hidden = col.length - recent.length;
      col = recent.sort((a, b) => +new Date(b.completedAt!) - +new Date(a.completedAt!));
    }
    return { status, col, hidden, cap: limit[status] ?? BOARD_CAP };
  });

  const dropAt = (status: TaskStatus, before: WorkItem | null) => {
    const id = dragId;
    setDragId(null);
    setOverCol(null);
    if (!id) return;
    const col = columns.find((c) => c.status === status)!.col.filter((t) => t.id !== id);
    let order: number;
    if (!before) order = col.length ? col[col.length - 1].sortOrder + 1 : now / 1000;
    else {
      const i = col.findIndex((t) => t.id === before.id);
      const prev = col[i - 1];
      order = prev ? (prev.sortOrder + before.sortOrder) / 2 : before.sortOrder - 1;
    }
    const cur = all.find((t) => t.id === id);
    if (cur && cur.status === status && cur.sortOrder === order) return;
    onMove(id, status, order);
  };

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {columns.map(({ status, col, hidden, cap }) => {
        const meta = STATUS_META[status];
        const active = overCol === status && !!dragId;
        if (status === "done" && !doneOpen && !dragId) {
          return (
            <button
              key={status}
              type="button"
              onClick={toggleDone}
              title="Show the Done column"
              className="flex w-10 shrink-0 flex-col items-center gap-3 rounded-2xl py-3 text-ink-faint transition hover:bg-white/4 hover:text-ink-dim"
            >
              <span className="size-2 rounded-full" style={{ background: meta.color }} />
              <span className="font-display text-xs font-medium uppercase tracking-[0.2em] [writing-mode:vertical-rl]">
                {meta.label} · {col.length + hidden}
              </span>
            </button>
          );
        }
        return (
          <section
            key={status}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overCol !== status) setOverCol(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverCol((s) => (s === status ? null : s));
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropAt(status, null);
            }}
            className={cn(
              "flex min-h-40 w-64 shrink-0 flex-col gap-2 rounded-2xl p-2 transition-colors lg:w-auto lg:min-w-0 lg:flex-1",
              active ? "bg-white/[0.03] outline outline-1 outline-dashed" : "outline-none",
            )}
            style={active ? { outlineColor: meta.color } : undefined}
            aria-label={meta.label}
          >
            <header className="flex items-center gap-2 px-1 pb-1">
              <span className="size-2 rounded-full" style={{ background: meta.color }} />
              <h2 className="font-display text-xs font-medium uppercase tracking-[0.2em] text-ink-dim">{meta.label}</h2>
              <span className="ml-auto font-mono text-xs tabular-nums text-ink-faint">{col.length + hidden}</span>
              {status === "done" && (
                <button
                  type="button"
                  onClick={toggleDone}
                  title="Fold the Done column"
                  className="rounded px-1 font-mono text-xs text-ink-faint transition hover:bg-white/6 hover:text-ink"
                >
                  ‹
                </button>
              )}
            </header>
            {col.length === 0 && (
              <div className={cn("rounded-xl border border-dashed py-6 text-center font-mono text-[10px] uppercase tracking-widest", active ? "border-white/20 text-ink-dim" : "border-white/6 text-ink-faint")}>
                {active ? "drop here" : "empty"}
              </div>
            )}
            {col.slice(0, cap).map((t) => (
              <Card
                key={t.id}
                item={t}
                compact={compact}
                subCount={subCounts.get(t.id)}
                blocked={flags.blocked.has(t.id)}
                delegated={flags.delegated[t.id]}
                dragging={dragId === t.id}
                onOpen={() => onOpen(t.id)}
                onDragStart={() => setDragId(t.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverCol(null);
                }}
                onDropBefore={() => dropAt(status, t)}
              />
            ))}
            {col.length > cap && (
              <button
                type="button"
                onClick={() => setLimit((l) => ({ ...l, [status]: cap + BOARD_CAP * 2 }))}
                className="rounded-lg py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/4 hover:text-ink-dim"
              >
                show {Math.min(BOARD_CAP * 2, col.length - cap)} more · {col.length - cap} hidden
              </button>
            )}
            {status === "done" && (hidden > 0 || olderDone) && (
              <button
                type="button"
                onClick={() => setOlderDone((v) => !v)}
                className="rounded-lg py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/4 hover:text-ink-dim"
              >
                {olderDone ? "only last 14 days" : `+ ${hidden} older`}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ── list ───────────────────────────────────────────────────────────────────

function ListView({
  items,
  data,
  flags,
  showProject,
  onOpen,
}: {
  items: WorkItem[];
  data: WorkData;
  flags: { blocked: Set<string>; delegated: Record<string, string> };
  showProject: boolean;
  onOpen: (id: string) => void;
}) {
  const [folded, setFolded] = useState<Set<TaskStatus>>(new Set(["done", "cancelled"]));
  const projectName = useMemo(() => new Map(data.projects.map((p) => [p.id, p.name])), [data.projects]);
  return (
    <div className="flex flex-col gap-3">
      {TASK_STATUSES.map((status) => {
        const rows = items
          .filter((t) => t.status === status)
          .sort((a, b) =>
            closed(status)
              ? +new Date(b.completedAt ?? 0) - +new Date(a.completedAt ?? 0)
              : PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank || a.sortOrder - b.sortOrder,
          );
        if (!rows.length) return null;
        const isFolded = folded.has(status);
        return (
          <section key={status} className="glass overflow-hidden rounded-xl">
            <button
              type="button"
              onClick={() =>
                setFolded((prev) => {
                  const n = new Set(prev);
                  if (n.has(status)) n.delete(status);
                  else n.add(status);
                  return n;
                })
              }
              aria-expanded={!isFolded}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/3"
            >
              <span className="size-2 rounded-full" style={{ background: STATUS_META[status].color }} />
              <span className="font-display text-xs font-medium uppercase tracking-[0.2em] text-ink-dim">{STATUS_META[status].label}</span>
              <span className="font-mono text-xs tabular-nums text-ink-faint">{rows.length}</span>
              <ChevronDown className={cn("ml-auto size-3.5 text-ink-faint transition-transform", isFolded && "-rotate-90")} />
            </button>
            {!isFolded && (
              <ul className="divide-y divide-white/5 border-t border-white/5">
                {rows.map((t) => {
                  const pid = t.projectRef?.startsWith("projects:") ? t.projectRef.slice(9) : null;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-white/3"
                      >
                        <PriorityIcon p={t.priority} />
                        <span className="w-16 shrink-0 font-mono text-[10px] text-ink-faint">{t.identifier}</span>
                        <span dir="auto" className={cn("min-w-0 flex-1 truncate text-sm", closed(t.status) ? "text-ink-faint line-through" : "text-ink-dim")}>
                          {t.parentId && <span className="mr-1 text-ink-faint">↳</span>}
                          {displayTitle(t)}
                        </span>
                        <span className="hidden items-center gap-1.5 sm:flex">
                          <Flags blocked={flags.blocked.has(t.id)} delegated={flags.delegated[t.id]} />
                          <Labels labels={t.labels} />
                        </span>
                        {t.estimate != null && <span className="font-mono text-[10px] tabular-nums text-ink-faint">{t.estimate}p</span>}
                        <DueChip item={t} />
                        {showProject && (
                          <span className="hidden w-28 truncate text-right font-mono text-[10px] text-ink-faint md:block">
                            {pid ? projectName.get(pid) : "—"}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {items.length === 0 && (
        <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">Nothing matches.</p>
      )}
    </div>
  );
}

// ── the view ───────────────────────────────────────────────────────────────

type Tab = "items" | "cycles" | "modules" | "timeline" | "overview";
type Layout = "board" | "list" | "calendar";
const LAYOUTS: Layout[] = ["board", "list", "calendar"];

/**
 * Tab + detail selection live in the URL (?tab=modules&module=…) so a module or
 * cycle page is linkable. A project page opens on its Overview (the cockpit);
 * the all-work page opens on Work items.
 */
function useWorkUrl(hasOverview: boolean) {
  const sp = useSearchParams();
  const raw = sp.get("tab");
  const tabs: Tab[] = ["items", "cycles", "modules", "timeline", ...(hasOverview ? (["overview"] as Tab[]) : [])];
  const fallback: Tab = hasOverview ? "overview" : "items";
  const tab: Tab = raw && (tabs as string[]).includes(raw) ? (raw as Tab) : fallback;
  const go = useCallback(
    (next: { tab?: Tab; module?: string | null; cycle?: string | null }) => {
      const p = new URLSearchParams(sp.toString());
      const t = next.tab ?? tab;
      if (t === fallback) p.delete("tab");
      else p.set("tab", t);
      for (const k of ["module", "cycle"] as const) {
        const v = next[k];
        if (v === undefined && next.tab && next.tab !== tab) p.delete(k);
        else if (v === null) p.delete(k);
        else if (v) p.set(k, v);
      }
      const qs = p.toString();
      window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
    },
    [sp, tab, fallback],
  );
  return { tab, moduleId: tab === "modules" ? sp.get("module") : null, cycleId: tab === "cycles" ? sp.get("cycle") : null, go };
}

/**
 * The Work surface — one component for /m/tasks (all work) and a project page
 * (scoped, with an Overview tab for the cockpit). Tabs, Plane-style: Work items
 * (board ⇄ list, quick-create with inline tokens, filters), Cycles and Modules
 * (each with a detail page: header + that slice of items), Timeline; a side
 * drawer for the item.
 */
export function WorkView({ data, projectId, overview }: { data: WorkData; projectId?: string; overview?: React.ReactNode }) {
  const router = useRouter();
  // Local copy for optimistic moves; re-seeded whenever the server sends new data.
  const [items, setItems] = useState(data.items);
  const [seed, setSeed] = useState(data.items);
  if (seed !== data.items) {
    setSeed(data.items);
    setItems(data.items);
  }
  const now = useNow();
  const [, startMove] = useTransition();
  const { tab, moduleId, cycleId, go } = useWorkUrl(!!overview);

  const prefKey = projectId ? "work.layout.project" : "work.layout.all";
  const [layout, setLayout] = useState<Layout>("board");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered layout after hydration (localStorage is client-only)
  useEffect(() => setLayout(readPref<Layout>(prefKey, "board", LAYOUTS)), [prefKey]);
  const pickLayout = (v: Layout) => {
    setLayout(v);
    writePref(prefKey, v);
  };

  // Board density: comfortable (2-line cards) or compact (one row per item).
  const [compact, setCompact] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered density after hydration (localStorage is client-only)
  useEffect(() => setCompact(readPref("work.board.density", "comfortable", ["comfortable", "compact"]) === "compact"), []);
  const toggleCompact = () => {
    writePref("work.board.density", compact ? "comfortable" : "compact");
    setCompact(!compact);
  };

  const [q, setQ] = useState("");
  const [label, setLabel] = useState("");
  const [project, setProject] = useState("");
  const [feature, setFeature] = useState("");
  const [cycle, setCycle] = useState("");
  const [planeOpen, setPlaneOpen] = useState(false);
  const flags = useMemo(() => ({ blocked: new Set(data.blocked), delegated: data.delegated }), [data.blocked, data.delegated]);
  const currentCycles = useMemo(() => new Set(data.cycles.filter((c) => c.status === "current").map((c) => c.id)), [data.cycles]);
  const [openId, setOpenId] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  const openModule = moduleId ? data.features.find((f) => f.id === moduleId) : undefined;
  const openCycle = cycleId ? data.cycles.find((c) => c.id === cycleId) : undefined;
  // The item surface shows on Work items and on a module / cycle page.
  const itemSurface = tab === "items" || !!openModule || !!openCycle;
  const scopeFeature = openModule?.id ?? feature;
  const scopeCycle = openCycle?.id ?? cycle;

  // "C" jumps to quick-create; Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (e.key === "Escape" && openId) setOpenId(null);
      else if (!typing && !openId && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        quickRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  const allLabels = useMemo(() => [...new Set(items.flatMap((t) => t.labels))].sort(), [items]);
  // Not memoized by hand: the React Compiler handles it (scope comes from a derived lookup).
  const needle = q.trim().toLowerCase();
  const filtered = items.filter(
    (t) =>
      (!needle || t.title.toLowerCase().includes(needle) || t.identifier?.toLowerCase() === needle) &&
      (!label || t.labels.includes(label)) &&
      (!project || (project === "none" ? !t.projectRef : t.projectRef === `projects:${project}`)) &&
      (!scopeFeature || (scopeFeature === "none" ? !t.featureRef : t.featureRef === `features:${scopeFeature}`)) &&
      (!scopeCycle ||
        (scopeCycle === "current"
          ? !!t.cycleId && currentCycles.has(t.cycleId)
          : scopeCycle === "none"
            ? !t.cycleId
            : t.cycleId === scopeCycle)),
    );


  const refresh = useCallback(() => router.refresh(), [router]);

  // Saved views capture the Work-items filters + layout (not a module / cycle page's scope).
  const currentFilters: WorkViewFilters = { q, label, project, feature, cycle, layout };
  const applyView = (f: WorkViewFilters) => {
    setQ(f.q ?? "");
    setLabel(f.label ?? "");
    setProject(f.project ?? "");
    setFeature(f.feature ?? "");
    setCycle(f.cycle ?? "");
    if (f.layout && LAYOUTS.includes(f.layout)) pickLayout(f.layout);
  };

  const onMove = (id: string, status: TaskStatus, sortOrder: number) => {
    // Optimistic: the card lands immediately; the server write + refresh reconcile.
    setItems((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status, sortOrder, completedAt: closed(status) ? (t.completedAt ?? new Date(now)) : null }
          : t,
      ),
    );
    startMove(async () => {
      await moveTask(id, status, sortOrder);
      refresh();
    });
  };

  const liveFeatures = data.features.filter((f) => f.status === "planned" || f.status === "active" || f.status === "paused");
  const tabs: { id: Tab; label: string; icon: typeof List; count?: number }[] = [
    ...(overview ? [{ id: "overview" as Tab, label: "Overview", icon: Gauge }] : []),
    { id: "items", label: "Work items", icon: Columns3, count: items.filter((t) => !closed(t.status)).length },
    { id: "cycles", label: "Cycles", icon: Repeat, count: data.cycles.filter((c) => c.status !== "completed").length },
    { id: "modules", label: "Modules", icon: Layers, count: liveFeatures.length },
    { id: "timeline", label: "Timeline", icon: CalendarRange },
  ];
  const selectCls = "rounded-lg border border-white/8 bg-panel px-2 py-1 text-xs text-ink-dim outline-none";

  return (
    <div className="flex flex-col gap-4">
      <nav className="-mx-1 flex items-center gap-1 overflow-x-auto border-b border-white/6 px-1" role="tablist" aria-label="Project sections">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => go({ tab: t.id, module: null, cycle: null })}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-widest transition",
                active ? "border-ion text-ink" : "border-transparent text-ink-faint hover:text-ink-dim",
              )}
            >
              <t.icon className={cn("size-3.5", active && "text-ion")} />
              {t.label}
              {t.count != null && t.count > 0 && <span className="tabular-nums text-ink-faint">{t.count}</span>}
            </button>
          );
        })}
        {!projectId && (
          <button
            type="button"
            onClick={() => setPlaneOpen(true)}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/5 hover:text-ink"
          >
            <Download className="size-3.5" /> import from Plane
          </button>
        )}
      </nav>

      {tab === "overview" && overview}

      {tab === "modules" && !openModule && (
        <ModulesView
          features={data.features}
          items={items}
          projects={data.projects}
          projectId={projectId}
          onOpen={(id) => go({ module: id })}
        />
      )}
      {openModule && (
        <ModuleHeader
          f={openModule}
          items={items}
          project={data.projects.find((p) => p.id === openModule.projectId)}
          onBack={() => go({ module: null })}
          onDeleted={() => go({ module: null })}
        />
      )}

      {tab === "cycles" && !openCycle && (
        <CyclesView cycles={data.cycles} items={items} projectId={projectId} projects={data.projects} onSelect={(id) => go({ cycle: id })} />
      )}
      {openCycle && <CycleHeader c={openCycle} next={nextCycleFor(data.cycles, openCycle)} onBack={() => go({ cycle: null })} />}

      {tab === "timeline" && (
        <Timeline
          items={items}
          features={projectId ? data.features : data.features.filter((f) => f.status !== "shipped")}
          projects={data.projects}
          byFeature={!!projectId}
          onOpen={setOpenId}
          onOpenModule={(id) => go({ tab: "modules", module: id })}
        />
      )}

      {itemSurface && (
        <>
          <QuickCreate inputRef={quickRef} data={data} projectId={projectId} featureId={openModule?.id ?? (feature && feature !== "none" ? feature : null)} cycleId={openCycle?.id ?? null} />

          {tab === "items" && (
            <SavedViews
              views={data.views}
              current={currentFilters}
              projectId={projectId ?? null}
              onApply={applyView}
              onChanged={refresh}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-white/8 p-0.5" role="radiogroup" aria-label="Layout">
              {([
                { id: "board", label: "Board", icon: Columns3 },
                { id: "list", label: "List", icon: List },
                { id: "calendar", label: "Calendar", icon: CalendarDays },
              ] as const).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={layout === v.id}
                  onClick={() => pickLayout(v.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition",
                    layout === v.id ? "bg-ion/15 text-ion" : "text-ink-faint hover:text-ink-dim",
                  )}
                >
                  <v.icon className="size-3.5" />
                  {v.label}
                </button>
              ))}
            </div>
            {layout === "board" && (
              <button
                type="button"
                onClick={toggleCompact}
                aria-pressed={compact}
                title={compact ? "Comfortable cards" : "Compact cards — one row per item"}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition",
                  compact ? "border-ion/30 bg-ion/10 text-ion" : "border-white/8 text-ink-faint hover:text-ink-dim",
                )}
              >
                <Rows3 className="size-3.5" />
                compact
              </button>
            )}
            <label className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2 py-1">
              <Search className="size-3.5 text-ink-faint" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter items"
                className="w-32 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
              />
              {q && (
                <button type="button" onClick={() => setQ("")} aria-label="Clear filter">
                  <X className="size-3 text-ink-faint" />
                </button>
              )}
            </label>
            {allLabels.length > 0 && (
              <select value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" className={selectCls}>
                <option value="">all labels</option>
                {allLabels.map((l) => (
                  <option key={l} value={l}>#{l}</option>
                ))}
              </select>
            )}
            {!projectId && (
              <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={selectCls}>
                <option value="">all projects</option>
                <option value="none">no project</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key ? `${p.key} · ` : ""}{p.name}
                  </option>
                ))}
              </select>
            )}
            {!openModule && data.features.length > 0 && (
              <select value={feature} onChange={(e) => setFeature(e.target.value)} aria-label="Module" className={cn(selectCls, "max-w-48")}>
                <option value="">all modules</option>
                <option value="none">no module</option>
                {liveFeatures.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            )}
            {!openCycle && data.cycles.length > 0 && (
              <select value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label="Cycle" className={selectCls}>
                <option value="">all cycles</option>
                {currentCycles.size > 0 && <option value="current">current cycle</option>}
                <option value="none">no cycle</option>
                {data.cycles.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
            <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
              {filtered.filter((t) => !closed(t.status)).length} open
            </span>
          </div>

          {layout === "board" && <Board items={filtered} all={items} flags={flags} onOpen={setOpenId} onMove={onMove} compact={compact} />}
          {layout === "list" && <ListView items={filtered} data={data} flags={flags} showProject={!projectId} onOpen={setOpenId} />}
          {layout === "calendar" && <CalendarView items={filtered} onOpen={setOpenId} />}
        </>
      )}

      {planeOpen && <PlaneImport onClose={() => setPlaneOpen(false)} />}

      <AnimatePresence>
        {openId && (
          <>
            <motion.div
              key="scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpenId(null)}
              className="fixed inset-0 z-40 bg-void/70 backdrop-blur-sm"
            />
            <motion.aside
              key="drawer"
              initial={{ x: "100%", opacity: 0.6 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0.4 }}
              transition={{ type: "spring", stiffness: 320, damping: 34 }}
              role="dialog"
              aria-modal="true"
              aria-label="Work item"
              className="glass fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto rounded-l-2xl p-6"
            >
              <button
                type="button"
                onClick={() => setOpenId(null)}
                aria-label="Close"
                className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-faint transition hover:bg-white/6 hover:text-ink"
              >
                <X className="size-4" />
              </button>
              <WorkItemDetail
                key={openId}
                id={openId}
                projects={data.projects}
                onChanged={refresh}
                onOpenItem={setOpenId}
                onDeleted={() => setOpenId(null)}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── saved views ────────────────────────────────────────────────────────────

const FILTER_KEYS = ["q", "label", "project", "feature", "cycle"] as const;
const sameFilters = (a: WorkViewFilters, b: WorkViewFilters) =>
  FILTER_KEYS.every((k) => (a[k] ?? "") === (b[k] ?? "")) && (!b.layout || a.layout === b.layout);

/** Named filter sets: a chip per view restores its filters and layout; "save view" names the current ones. */
function SavedViews({
  views,
  current,
  projectId,
  onApply,
  onChanged,
}: {
  views: SavedView[];
  current: WorkViewFilters;
  projectId: string | null;
  onApply: (f: WorkViewFilters) => void;
  onChanged: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const filtered = FILTER_KEYS.some((k) => current[k]);
  const active = views.find((v) => sameFilters(current, v.filters));
  if (!views.length && !filtered) return null;

  const save = () =>
    start(async () => {
      if (!name.trim()) return;
      await saveWorkView(projectId, name, current);
      setName("");
      setNaming(false);
      onChanged();
    });

  const chip = "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest transition";
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Saved views">
      <Bookmark className="size-3.5 text-ink-faint" />
      <button
        type="button"
        onClick={() => onApply({ layout: current.layout })}
        className={cn(chip, !filtered ? "border-ion/40 bg-ion/10 text-ion" : "border-white/8 text-ink-faint hover:text-ink")}
      >
        everything
      </button>
      {views.map((v) => (
        <span key={v.id} className={cn(chip, "group pr-1", active?.id === v.id ? "border-ion/40 bg-ion/10 text-ion" : "border-white/8 text-ink-dim hover:text-ink")}>
          <button type="button" onClick={() => onApply(v.filters)} className="normal-case tracking-normal">
            {v.name}
          </button>
          <button
            type="button"
            aria-label={`Delete view ${v.name}`}
            title="Delete this view"
            onClick={() =>
              start(async () => {
                await deleteWorkView(v.id);
                onChanged();
              })
            }
            className="rounded-full p-0.5 text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-flare focus-visible:opacity-100"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {filtered && !active && !naming && (
        <button type="button" onClick={() => setNaming(true)} className={cn(chip, "border-dashed border-white/12 text-ink-faint hover:text-ink")}>
          <Plus className="size-3" /> save view
        </button>
      )}
      {naming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex items-center gap-1"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
            placeholder="View name…"
            aria-label="View name"
            maxLength={60}
            className="w-36 rounded-full border border-white/12 bg-transparent px-2.5 py-0.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-ion/50"
          />
          <button type="submit" disabled={pending || !name.trim()} className={cn(chip, "border-ion/40 text-ion disabled:opacity-40")}>
            save
          </button>
        </form>
      )}
    </div>
  );
}
