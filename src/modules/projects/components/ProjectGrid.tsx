"use client";

import { lastActiveLabel } from "@/core/ui/time";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { ArrowRight, ChevronDown, Compass, FolderPlus, GripVertical, ListChecks } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { createProject, setProjectCategoryOrder } from "../actions";
import type { ProjectCockpit } from "../queries";
import { HEALTH_META } from "../health";
import { STATUS_CHIP } from "./statusStyle";
import { categoryColor } from "./categoryColor";

// shared: core/ui/time.ts lastActiveLabel

function NewProjectForm() {
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const name = inputRef.current?.value.trim();
    if (!name) return;
    startTransition(async () => {
      if (!(await act(() => createProject({ name }), { failed: "Couldn't create the project" })).ok) return;
      if (inputRef.current) inputRef.current.value = "";
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex min-w-72 items-center gap-2 rounded-[10px] border border-ion/20 bg-raise/60 py-1 pl-3 pr-1 transition focus-within:border-plasma/50"
    >
      <FolderPlus className="size-3.5 shrink-0 text-plasma" />
      <input
        ref={inputRef}
        placeholder="New project…"
        aria-label="New project name"
        autoFocus
        className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        disabled={pending}
      />
      <button type="submit" disabled={pending} className="wk-btn primary !py-1 text-xs disabled:opacity-40">
        {pending ? "…" : "Create"}
      </button>
    </form>
  );
}

function ProjectCard({
  project,
  muted,
}: {
  project: ProjectCockpit;
  muted?: boolean;
}) {
  const { total, done, overdue } = project.taskCounts;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const health = HEALTH_META[project.resolvedHealth.health];

  return (
    <motion.div
      layout
      layoutId={project.id}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: muted ? 0.72 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      <Link
        href={`/m/projects/${project.id}`}
        className="glass flex h-full flex-col rounded-2xl p-4 transition hover:bg-ink/4 hover:opacity-100"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[11.5px] text-ink-faint">{project.key ?? (project.kind === "area" ? "area" : "—")}</span>
          {project.status === "active" ? (
            <span
              title={project.resolvedHealth.reason}
              className="wk-chip !px-2 !py-px !text-[11.5px]"
              style={{ color: health.accent, borderColor: `color-mix(in oklab, ${health.accent} 35%, transparent)` }}
            >
              <span className="dot" />
              {health.label}
            </span>
          ) : (
            <span className={cn("shrink-0 rounded-full border px-2 py-px text-[11.5px] capitalize", STATUS_CHIP[project.status])}>
              {project.status}
            </span>
          )}
        </div>
        <h2 dir="auto" className="mt-1 font-display text-[17px] font-semibold leading-snug text-ink [text-wrap:balance]">
          {project.name}
        </h2>

        {project.nextAction ? (
          <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-snug text-ink-dim">
            <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-solar" />
            <span className="line-clamp-2">
              {project.nextActionSource === "advisor" && (
                <span className="mr-1.5 rounded border border-ion/30 px-1 py-px align-[1px] font-mono text-[10.5px] text-ion">
                  advisor
                </span>
              )}
              {project.nextAction}
            </span>
          </p>
        ) : project.description ? (
          <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-ink-dim">
            {project.description}
          </p>
        ) : null}

        <div className="mt-auto pt-4">
          {/* No work items yet: a dashed track + "not started", not an empty 0/0 bar. */}
          {total === 0 ? (
            <div className="h-1.5 rounded-full border border-dashed border-ion/15" />
          ) : (
            <div className="wk-bar !h-1.5">
              <motion.b
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 24 }}
                className="rounded-full bg-plasma"
              />
            </div>
          )}
          <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-ink-faint">
            <span>{lastActiveLabel(project.lastActivityAt)}</span>
            <span className="tabular-nums">
              {overdue > 0 && <span className="text-flare">{overdue} overdue · </span>}
              {total === 0 ? "no items yet" : `${done}/${total} done · ${pct}%`}
            </span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

function ProjectSection({
  projects,
  muted,
}: {
  projects: ProjectCockpit[];
  muted?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
      <AnimatePresence mode="popLayout">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} muted={muted} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Paused/done/archived aren't day-to-day — collapsed by default so they don't crowd out what's active. */
function InactiveProjects({ projects }: { projects: ProjectCockpit[] }) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-3 flex w-full items-center gap-2 border-t border-ion/10 pt-5 text-left"
      >
        <span className="wk-sec-h">Paused · done · archived</span>
        <span className="font-mono text-xs tabular-nums text-ink-faint">
          {projects.length}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 text-ink-faint transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <ProjectSection projects={projects} muted />}
    </div>
  );
}

/** Section header: a category's color dot + name + count (or a plain label). */
function GroupHeader({ label, count, color }: { label: string; count: number; color?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 px-1">
      {color && <span className="size-2 rounded-full" style={{ background: color }} />}
      <span className="wk-sec-h !text-ink-dim">{label}</span>
      <span className="font-mono text-xs tabular-nums text-ink-faint">{count}</span>
    </div>
  );
}

/** A draggable category group — grab the handle in its header to reorder. */
function CategoryGroup({ name, items }: { name: string; items: ProjectCockpit[] }) {
  const controls = useDragControls();
  return (
    <Reorder.Item value={name} dragListener={false} dragControls={controls}>
      <div className="group/cat mb-3 flex items-center gap-2 px-1">
        <button
          type="button"
          onPointerDown={(e) => controls.start(e)}
          title="Drag to reorder"
          className="cursor-grab touch-none text-ink-faint opacity-0 transition hover:text-ink-dim group-hover/cat:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
        <span className="size-2 rounded-full" style={{ background: categoryColor(name) }} />
        <span className="wk-sec-h !text-ink-dim">{name}</span>
        <span className="font-mono text-xs tabular-nums text-ink-faint">{items.length}</span>
      </div>
      <ProjectSection projects={items} />
    </Reorder.Item>
  );
}

/** Saved order wins (filtered to what exists); new categories append after. */
function reconcileOrder(live: string[], saved: string[]): string[] {
  const liveSet = new Set(live);
  return [...saved.filter((n) => liveSet.has(n)), ...live.filter((n) => !saved.includes(n))];
}

export function ProjectGrid({
  projects,
  categoryOrder,
}: {
  projects: ProjectCockpit[];
  categoryOrder: string[];
}) {
  // Active projects group by category; paused/done/archived stay in the
  // collapse at the bottom. Named category groups are drag-reorderable.
  const { byCat, liveNames, uncategorized, inactive, activeCount, areas } = useMemo(() => {
    // Areas of development are a different kind — a standing bucket to file
    // things under, not a deliverable — so they get their own section and never
    // mix into the category groups.
    const areas = projects
      .filter((p) => p.kind === "area" && p.status !== "archived")
      .sort((a, b) => a.name.localeCompare(b.name));
    const real = projects.filter((p) => p.kind !== "area");
    const active = real.filter((p) => p.status === "active");
    const inactive = real.filter((p) => p.status !== "active");
    const byCat = new Map<string, ProjectCockpit[]>();
    for (const p of active) {
      const key = p.category?.trim() || "";
      (byCat.get(key) ?? byCat.set(key, []).get(key)!).push(p);
    }
    const liveNames = [...byCat.keys()]
      .filter((k) => k !== "")
      .sort((a, b) => (byCat.get(b)!.length - byCat.get(a)!.length) || a.localeCompare(b));
    return { byCat, liveNames, uncategorized: byCat.get("") ?? [], inactive, activeCount: active.length, areas };
  }, [projects]);

  const [order, setOrder] = useState<string[]>(() => reconcileOrder(liveNames, categoryOrder));
  const [, startSave] = useTransition();
  const display = reconcileOrder(liveNames, order);

  const handleReorder = (next: string[]) => {
    const prev = order;
    setOrder(next);
    startSave(async () => {
      const r = await act(() => setProjectCategoryOrder(next), { failed: "Couldn't save the category order" });
      if (!r.ok) setOrder(prev);
    });
  };

  const overdueTotal = projects.reduce((n, p) => n + (p.status === "active" ? p.taskCounts.overdue : 0), 0);
  const openTotal = projects.reduce((n, p) => n + (p.status === "active" ? p.taskCounts.open : 0), 0);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-ink-faint">
            <Link href="/m/tasks" className="transition hover:text-ink">
              Work
            </Link>{" "}
            / Projects
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
            <h2 className="font-display text-[26px] font-semibold leading-tight tracking-[0.02em] text-ink">Projects</h2>
            <span className="wk-chip">
              <span className="font-mono tabular-nums text-ink">{activeCount}</span> active
            </span>
            <span className="wk-chip">
              <span className="font-mono tabular-nums text-ink">{openTotal}</span> open items
            </span>
            {overdueTotal > 0 && (
              <span className="wk-chip" style={{ color: "var(--color-flare)", borderColor: "color-mix(in oklab, var(--color-flare) 35%, transparent)" }}>
                <span className="dot" />
                {overdueTotal} overdue
              </span>
            )}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/m/tasks" className="wk-btn">
            <ListChecks className="size-3.5 text-ion" /> All work
          </Link>
          <NewProjectForm />
        </div>
      </header>

      <div className="flex flex-col gap-7">
        <Reorder.Group axis="y" values={display} onReorder={handleReorder} className="flex flex-col gap-7">
          {display.map((name) => (
            <CategoryGroup key={name} name={name} items={byCat.get(name) ?? []} />
          ))}
        </Reorder.Group>
        {uncategorized.length > 0 && (
          <div>
            <GroupHeader
              label={liveNames.length > 0 ? "uncategorized" : "active"}
              count={uncategorized.length}
            />
            <ProjectSection projects={uncategorized} />
          </div>
        )}

        {areas.length > 0 && (
          <div className="border-t border-ion/12 pt-6">
            <div className="mb-3 flex items-center gap-2 px-1">
              <Compass className="size-3.5 text-plasma" />
              <span className="wk-sec-h !text-plasma">Areas of development</span>
              <span className="font-mono text-xs tabular-nums text-ink-faint">
                {areas.length}
              </span>
            </div>
            <ProjectSection projects={areas} />
          </div>
        )}
      </div>

      {projects.length === 0 && (
        <div className="rounded-xl border border-dashed border-ion/10 py-12 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          no projects yet — start one above
        </div>
      )}
      {projects.length > 0 && activeCount === 0 && (
        <div className="rounded-xl border border-dashed border-ion/10 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          no active projects — see paused/done/archived below
        </div>
      )}

      <InactiveProjects projects={inactive} />
    </div>
  );
}
