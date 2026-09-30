"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "../core";
import type { WorkData } from "../queries";
import { TASK_STATUSES, type TaskStatus } from "../schema";
import { PRIORITY_META, STATUS_META, displayTitle, plainTitle } from "../states";
import { ItemMarks, subCounts, type Flags } from "./Board";
import { Due, Est, LabelPills, PriorityGlyph, StateGlyph, TitleTag, Who, botOwned, isClosed, splitTitle } from "./work-ui";

/**
 * Rows grouped by state, sorted by priority: priority, id, state, title,
 * labels, module, estimate, due, (project), owner — one scan line per item.
 */
export function ListView({
  items,
  data,
  flags,
  showProject,
  selectedId,
  onOpen,
}: {
  items: WorkItem[];
  data: WorkData;
  flags: Flags;
  showProject: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const now = useNow();
  const [folded, setFolded] = useState<Set<TaskStatus>>(new Set(["done", "cancelled"]));
  const projectName = useMemo(() => new Map(data.projects.map((p) => [p.id, p.key ?? p.name])), [data.projects]);
  const moduleName = useMemo(() => new Map(data.features.map((f) => [`features:${f.id}`, f.name])), [data.features]);
  const subs = useMemo(() => subCounts(data.items), [data.items]);

  return (
    <div className="wk-list flex flex-col gap-3.5">
      {TASK_STATUSES.map((status) => {
        const rows = items
          .filter((t) => t.status === status)
          .sort((a, b) =>
            isClosed(status)
              ? +new Date(b.completedAt ?? 0) - +new Date(a.completedAt ?? 0)
              : PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank || a.sortOrder - b.sortOrder,
          );
        if (!rows.length) return null;
        const isFolded = folded.has(status);
        const pts = rows.reduce((n, t) => n + (t.estimate ?? 0), 0);
        return (
          <section key={status}>
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
              className="mb-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[12.5px] font-semibold text-ink-dim transition hover:text-ink"
            >
              <ChevronDown className={cn("size-3.5 text-ink-faint transition-transform", isFolded && "-rotate-90")} />
              <StateGlyph s={status} />
              {STATUS_META[status].label}
              <span className="font-mono font-normal tabular-nums text-ink-faint">{rows.length}</span>
              {pts > 0 && <span className="ml-auto font-mono text-[11px] font-normal tabular-nums text-ink-faint">{pts} pts</span>}
            </button>
            {!isFolded && (
              <ul className="flex flex-col">
                {rows.map((t) => {
                  const pid = t.projectRef?.startsWith("projects:") ? t.projectRef.slice(9) : null;
                  const { tag, text } = splitTitle(displayTitle(t));
                  const blocker = flags.blocked.has(t.id) ? (flags.blockerOf.get(t.id) ?? "blocked") : null;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(t.id)}
                        aria-pressed={selectedId === t.id}
                        title={plainTitle(t.title)}
                        className={cn("wk-row", showProject && "proj", selectedId === t.id && "sel")}
                      >
                        <PriorityGlyph p={t.priority} />
                        <span className="truncate font-mono text-[12px] text-ink-faint">{t.identifier}</span>
                        <span className="wk-hide-sm">
                          <StateGlyph s={t.status} />
                        </span>
                        <span dir="auto" className={cn("flex min-w-0 items-center gap-2", isClosed(t.status) ? "text-ink-faint line-through" : "text-ink")}>
                          {t.parentId && <span className="text-ink-faint">↳</span>}
                          {blocker && <span className="wk-blocked">⛓ {blocker}</span>}
                          <span className="min-w-[7rem] shrink truncate">{text}</span>
                          {tag && (
                            <span className="hidden min-w-0 max-w-[14rem] shrink-[4] lg:inline-flex">
                              <TitleTag tag={tag} />
                            </span>
                          )}
                        </span>
                        <span className="wk-hide-sm flex items-center gap-[5px] justify-self-end">
                          <ItemMarks item={t} flags={flags} sub={subs.get(t.id)} />
                          <LabelPills labels={t.labels} max={2} />
                        </span>
                        <span className="wk-hide-sm wk-hide-md truncate text-[12px] text-ink-dim">{t.featureRef ? moduleName.get(t.featureRef) : ""}</span>
                        <span className="wk-hide-sm wk-hide-md justify-self-start">
                          <Est n={t.estimate} />
                        </span>
                        <span className="wk-hide-sm">
                          <Due item={t} now={now} />
                        </span>
                        {showProject && (
                          <span className="wk-hide-sm min-w-0 justify-self-start">
                            <span className="wk-pill block">{pid ? projectName.get(pid) : "—"}</span>
                          </span>
                        )}
                        <Who bot={botOwned(flags.delegated[t.id])} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {items.length === 0 && <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">Nothing matches.</p>}
    </div>
  );
}
