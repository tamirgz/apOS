"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, GitCommitHorizontal, Layers, Link2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "../core";
import type { WorkCommit } from "../queries";
import type { TaskStatus } from "../schema";
import { BOARD_STATUSES, STATUS_META, displayTitle, plainTitle } from "../states";
import { readPref, writePref } from "./prefs";
import { Due, Est, LabelPills, PriorityGlyph, StateGlyph, TitleTag, Who, botOwned, isClosed, splitTitle } from "./work-ui";

const DONE_WINDOW_DAYS = 14;
const BOARD_CAP = 25;
const DAY = 86_400_000;

export interface Flags {
  /** Open items with an open blocker. */
  blocked: Set<string>;
  /** blocked item id → the identifier of (one of) its blockers, for the ⛓ marker. */
  blockerOf: Map<string, string>;
  delegated: Record<string, string>;
  commits: Record<string, WorkCommit>;
}

/** The marker set a card / row carries: blocked-by, a linked commit or run, sub-item progress. */
export function ItemMarks({ item, flags, sub }: { item: WorkItem; flags: Flags; sub?: { done: number; total: number } }) {
  const commit = flags.commits[item.id];
  const run = flags.delegated[item.id];
  return (
    <>
      {commit && (
        <span className="wk-link" title={commit.title ?? "Linked commit"}>
          <GitCommitHorizontal className="size-3" />
          {commit.ref.slice(0, 7)}
        </span>
      )}
      {run && botOwned(run) && (
        <span className="wk-link" title={`Workbench run: ${run.replace("_", " ")}`}>
          <Link2 className="size-3" />
          {run === "needs_input" ? "needs input" : run}
        </span>
      )}
      {sub && (
        <span className="wk-due inline-flex items-center gap-1" title="Sub-items done">
          <Layers className="size-3" />
          {sub.done}/{sub.total}
        </span>
      )}
    </>
  );
}

function Card({
  item,
  flags,
  sub,
  selected,
  dragging,
  compact,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropBefore,
}: {
  item: WorkItem;
  flags: Flags;
  sub?: { done: number; total: number };
  selected: boolean;
  dragging: boolean;
  compact: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
}) {
  const [over, setOver] = useState(false);
  const now = useNow();
  const { tag, text } = splitTitle(displayTitle(item));
  const blocker = flags.blocked.has(item.id) ? (flags.blockerOf.get(item.id) ?? "blocked") : null;
  const bot = botOwned(flags.delegated[item.id]);
  const closed = isClosed(item.status);

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
      aria-pressed={selected}
      title={plainTitle(item.title)}
      className={cn(
        "wk-card outline-none focus-visible:ring-1 focus-visible:ring-plasma/60",
        compact && "gap-1 py-1.5",
        selected && "sel",
        dragging && "dragging",
        over && "before:absolute before:inset-x-2 before:-top-1.5 before:h-0.5 before:rounded-full before:bg-plasma",
      )}
    >
      <div className="flex min-w-0 items-center gap-[7px]">
        <PriorityGlyph p={item.priority} />
        <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">{item.identifier}</span>
        {blocker && (
          <span className="wk-blocked" title={blocker === "blocked" ? "Blocked by an open item" : `Blocked by ${blocker}`}>
            ⛓ {blocker}
          </span>
        )}
        {compact && (
          <span dir="auto" className={cn("min-w-0 flex-1 truncate text-[13px]", closed ? "text-ink-faint line-through" : "text-ink")}>
            {text}
          </span>
        )}
        <span className="ml-auto">
          <Who bot={bot} />
        </span>
      </div>
      {!compact && (
        <>
          {tag && (
            <div className="-mb-1 flex min-w-0">
              <TitleTag tag={tag} />
            </div>
          )}
          <p dir="auto" className={cn("line-clamp-3 text-[13.5px] leading-[1.35]", closed ? "text-ink-faint line-through" : "text-ink")}>
            {text}
          </p>
          {(item.labels.length > 0 || item.estimate != null || item.dueAt || sub || flags.commits[item.id] || bot) && (
            <div className="flex flex-wrap items-center gap-[5px]">
              <LabelPills labels={item.labels} max={2} />
              <Est n={item.estimate} />
              <Due item={item} now={now} />
              <ItemMarks item={item} flags={flags} sub={sub} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function subCounts(all: WorkItem[]) {
  const m = new Map<string, { done: number; total: number }>();
  for (const t of all) {
    if (!t.parentId) continue;
    const c = m.get(t.parentId) ?? { done: 0, total: 0 };
    c.total++;
    if (isClosed(t.status)) c.done++;
    m.set(t.parentId, c);
  }
  return m;
}

/** Kanban: one column per state, drag to move or reorder, points per column. */
export function Board({
  items,
  all,
  flags,
  selectedId,
  onOpen,
  onMove,
  compact = false,
}: {
  compact?: boolean;
  items: WorkItem[];
  all: WorkItem[];
  flags: Flags;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus, sortOrder: number) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);
  const [olderDone, setOlderDone] = useState(false);
  // Done can be folded to a slim rail; open by default, remembered per browser.
  const [doneOpen, setDoneOpen] = useState(true);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered choice after hydration (localStorage is client-only)
  useEffect(() => setDoneOpen(readPref("work.board.done", "open", ["open", "closed"]) === "open"), []);
  const toggleDone = () => {
    setDoneOpen((o) => {
      writePref("work.board.done", o ? "closed" : "open");
      return !o;
    });
  };
  // Big projects (an imported backlog runs to hundreds) would render every card: cap each column.
  const [limit, setLimit] = useState<Partial<Record<TaskStatus, number>>>({});
  const now = useNow();
  const subs = useMemo(() => subCounts(all), [all]);

  const columns = BOARD_STATUSES.map((status) => {
    let col = items.filter((t) => t.status === status).sort((a, b) => a.sortOrder - b.sortOrder);
    let hidden = 0;
    if (status === "done" && !olderDone) {
      const recent = col.filter((t) => t.completedAt && now - +new Date(t.completedAt) < DONE_WINDOW_DAYS * DAY);
      hidden = col.length - recent.length;
      col = recent.sort((a, b) => +new Date(b.completedAt!) - +new Date(a.completedAt!));
    }
    const pts = col.reduce((n, t) => n + (t.estimate ?? 0), 0);
    return { status, col, hidden, pts, cap: limit[status] ?? BOARD_CAP };
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

  const more = "rounded-lg py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-ink/5 hover:text-ink-dim";

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {columns.map(({ status, col, hidden, pts, cap }) => {
        const meta = STATUS_META[status];
        if (status === "done" && !doneOpen && !dragId) {
          return (
            <button
              key={status}
              type="button"
              onClick={toggleDone}
              title="Show the Done column"
              className="wk-col w-11 min-w-11 shrink-0 items-center !gap-3 py-3 text-ink-faint transition hover:text-ink-dim"
            >
              <StateGlyph s="done" />
              <span className="text-[12.5px] font-semibold [writing-mode:vertical-rl]">
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
            className={cn("wk-col w-[250px] shrink-0 xl:w-auto xl:min-w-[210px] xl:flex-1", overCol === status && !!dragId && "over")}
            aria-label={meta.label}
          >
            <header className="flex items-center gap-2 px-1 pb-1.5 pt-1 text-[12.5px] text-ink-dim">
              <StateGlyph s={status} />
              <h2 className="font-semibold text-ink">{meta.label}</h2>
              <span className="font-mono text-[11.5px] tabular-nums text-ink-faint">{col.length + hidden}</span>
              {pts > 0 && <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-faint">{pts} pts</span>}
              {status === "done" && (
                <button
                  type="button"
                  onClick={toggleDone}
                  title="Fold the Done column"
                  aria-label="Fold the Done column"
                  className={cn("rounded p-0.5 text-ink-faint transition hover:bg-ink/6 hover:text-ink", pts === 0 && "ml-auto")}
                >
                  <ChevronLeft className="size-3.5" />
                </button>
              )}
            </header>
            {col.length === 0 && (
              <div
                className={cn(
                  "rounded-xl border border-dashed py-6 text-center font-mono text-[10px] uppercase tracking-widest",
                  overCol === status && dragId ? "wk-line-strong text-ink-dim" : "wk-line text-ink-faint",
                )}
              >
                {overCol === status && dragId ? "drop here" : "nothing here"}
              </div>
            )}
            {col.slice(0, cap).map((t) => (
              <Card
                key={t.id}
                item={t}
                flags={flags}
                sub={subs.get(t.id)}
                compact={compact}
                selected={selectedId === t.id}
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
              <button type="button" onClick={() => setLimit((l) => ({ ...l, [status]: cap + BOARD_CAP * 2 }))} className={more}>
                show {Math.min(BOARD_CAP * 2, col.length - cap)} more · {col.length - cap} hidden
              </button>
            )}
            {status === "done" && (hidden > 0 || olderDone) && (
              <button type="button" onClick={() => setOlderDone((v) => !v)} className={more}>
                {olderDone ? `only last ${DONE_WINDOW_DAYS} days` : `+ ${hidden} older`}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
