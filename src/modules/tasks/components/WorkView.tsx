"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  Ban,
  Bot,
  CalendarClock,
  CalendarRange,
  ChevronDown,
  Columns3,
  Download,
  Layers,
  List,
  Plus,
  Repeat,
  Search,
  Signal,
  X,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import { createTask, moveTask } from "../actions";
import type { WorkItem } from "../core";
import { parseQuick } from "../parse";
import type { WorkData } from "../queries";
import { TASK_STATUSES, type TaskPriority, type TaskStatus } from "../schema";
import { BOARD_STATUSES, PRIORITY_META, STATUS_META } from "../states";
import { CyclesView } from "./CyclePanel";
import { FeatureRoadmap, FeatureStrip } from "./FeaturePanel";
import { PlaneImport } from "./PlaneImport";
import { Timeline } from "./Timeline";
import { WorkItemDetail } from "./WorkItemDetail";

type View = "board" | "list" | "cycles" | "timeline" | "features";
const ALL_VIEWS: View[] = ["board", "list", "cycles", "timeline", "features"];
const DONE_WINDOW_DAYS = 14;
const DAY = 86_400_000;
const closed = (s: TaskStatus) => s === "done" || s === "cancelled";

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode — preference just isn't remembered */
  }
}

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
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-violet" title={`Workbench: ${delegated}`}>
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
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  data: WorkData;
  projectId?: string;
  featureId: string | null;
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
}: {
  item: WorkItem;
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
        "glass group relative cursor-grab rounded-xl p-3 outline-none transition active:cursor-grabbing focus-visible:ring-1 focus-visible:ring-ion/50",
        dragging && "opacity-30",
        over && "before:absolute before:inset-x-2 before:-top-1.5 before:h-0.5 before:rounded-full before:bg-ion",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <PriorityIcon p={item.priority} />
        <span className="font-mono text-[10px] text-ink-faint">{item.identifier}</span>
        {item.estimate != null && (
          <span className="ml-auto rounded-md bg-white/5 px-1.5 font-mono text-[10px] tabular-nums text-ink-faint" title="Estimate">
            {item.estimate}
          </span>
        )}
      </div>
      <p dir="auto" className={cn("text-sm leading-snug", closed(item.status) ? "text-ink-faint line-through" : "text-ink-dim group-hover:text-ink")}>
        {item.title}
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
    </div>
  );
}

function Board({
  items,
  all,
  flags,
  onOpen,
  onMove,
}: {
  items: WorkItem[];
  all: WorkItem[];
  flags: { blocked: Set<string>; delegated: Record<string, string> };
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus, sortOrder: number) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);
  const [olderDone, setOlderDone] = useState(false);
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
    return { status, col, hidden };
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
      {columns.map(({ status, col, hidden }) => {
        const meta = STATUS_META[status];
        const active = overCol === status && !!dragId;
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
            </header>
            {col.length === 0 && (
              <div className={cn("rounded-xl border border-dashed py-6 text-center font-mono text-[10px] uppercase tracking-widest", active ? "border-white/20 text-ink-dim" : "border-white/6 text-ink-faint")}>
                {active ? "drop here" : "empty"}
              </div>
            )}
            {col.map((t) => (
              <Card
                key={t.id}
                item={t}
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
                          {t.title}
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

/**
 * The Work surface — one component for /m/tasks (all work) and a project page
 * (scoped). Board ⇄ List ⇄ Features, quick-create with inline tokens, filter
 * by text / label / project / feature, and a side drawer for the item.
 */
export function WorkView({ data, projectId }: { data: WorkData; projectId?: string }) {
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

  const prefKey = projectId ? "work.view.project" : "work.view.all";
  const [view, setView] = useState<View>("board");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered view after hydration (localStorage is client-only)
  useEffect(() => setView(readPref<View>(prefKey, "board", ALL_VIEWS)), [prefKey]);
  const pickView = (v: View) => {
    setView(v);
    writePref(prefKey, v);
  };

  const [q, setQ] = useState("");
  const [label, setLabel] = useState("");
  const [project, setProject] = useState("");
  const [feature, setFeature] = useState<string | null>(null);
  const [cycle, setCycle] = useState("");
  const [planeOpen, setPlaneOpen] = useState(false);
  const flags = useMemo(() => ({ blocked: new Set(data.blocked), delegated: data.delegated }), [data.blocked, data.delegated]);
  const currentCycles = useMemo(() => new Set(data.cycles.filter((c) => c.status === "current").map((c) => c.id)), [data.cycles]);
  const [openId, setOpenId] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);

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
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (t) =>
        (!needle || t.title.toLowerCase().includes(needle) || t.identifier?.toLowerCase() === needle) &&
        (!label || t.labels.includes(label)) &&
        (!project || (project === "none" ? !t.projectRef : t.projectRef === `projects:${project}`)) &&
        (!feature || t.featureRef === `features:${feature}`) &&
        (!cycle ||
          (cycle === "current" ? !!t.cycleId && currentCycles.has(t.cycleId) : cycle === "none" ? !t.cycleId : t.cycleId === cycle)),
    );
  }, [items, q, label, project, feature, cycle, currentCycles]);

  const refresh = useCallback(() => router.refresh(), [router]);

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

  const views: { id: View; label: string; icon: typeof List }[] = [
    { id: "board", label: "Board", icon: Columns3 },
    { id: "list", label: "List", icon: List },
    { id: "cycles", label: "Cycles", icon: Repeat },
    { id: "timeline", label: "Timeline", icon: CalendarRange },
    ...(projectId ? [] : [{ id: "features" as View, label: "Features", icon: Layers }]),
  ];
  const itemView = view === "board" || view === "list" || view === "timeline";

  return (
    <div className="flex flex-col gap-4">
      {projectId && (
        <FeatureStrip
          projectId={projectId}
          features={data.features}
          items={items}
          selected={feature}
          onSelect={setFeature}
        />
      )}

      {itemView && <QuickCreate inputRef={quickRef} data={data} projectId={projectId} featureId={feature} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-white/8 p-0.5" role="tablist" aria-label="View">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => pickView(v.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition",
                view === v.id ? "bg-ion/15 text-ion" : "text-ink-faint hover:text-ink-dim",
              )}
            >
              <v.icon className="size-3.5" />
              {v.label}
            </button>
          ))}
        </div>
        {itemView && (
          <>
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
              <select
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                aria-label="Label"
                className="rounded-lg border border-white/8 bg-panel px-2 py-1 text-xs text-ink-dim outline-none"
              >
                <option value="">all labels</option>
                {allLabels.map((l) => (
                  <option key={l} value={l}>#{l}</option>
                ))}
              </select>
            )}
            {!projectId && (
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                aria-label="Project"
                className="rounded-lg border border-white/8 bg-panel px-2 py-1 text-xs text-ink-dim outline-none"
              >
                <option value="">all projects</option>
                <option value="none">no project</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key ? `${p.key} · ` : ""}{p.name}
                  </option>
                ))}
              </select>
            )}
            {data.cycles.length > 0 && (
              <select
                value={cycle}
                onChange={(e) => setCycle(e.target.value)}
                aria-label="Cycle"
                className="rounded-lg border border-white/8 bg-panel px-2 py-1 text-xs text-ink-dim outline-none"
              >
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
          </>
        )}
        {!projectId && (
          <button
            type="button"
            onClick={() => setPlaneOpen(true)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/5 hover:text-ink",
              !itemView && "ml-auto",
            )}
          >
            <Download className="size-3.5" /> import from Plane
          </button>
        )}
      </div>

      {view === "board" && (
        <Board items={filtered} all={items} flags={flags} onOpen={setOpenId} onMove={onMove} />
      )}
      {view === "list" && <ListView items={filtered} data={data} flags={flags} showProject={!projectId} onOpen={setOpenId} />}
      {view === "cycles" && (
        <CyclesView
          cycles={data.cycles}
          items={items}
          projectId={projectId}
          projects={data.projects}
          onSelect={(id) => {
            setCycle(id);
            pickView("board");
          }}
        />
      )}
      {view === "timeline" && (
        <Timeline
          items={filtered}
          features={projectId ? data.features : data.features.filter((f) => f.status !== "shipped")}
          projects={data.projects}
          byFeature={!!projectId}
          onOpen={setOpenId}
        />
      )}
      {planeOpen && <PlaneImport onClose={() => setPlaneOpen(false)} />}
      {view === "features" && <FeatureRoadmap features={data.features} items={items} projects={data.projects} />}

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
