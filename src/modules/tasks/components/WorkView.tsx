"use client";

import { act } from "@/core/ui/feedback";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark,
  CalendarDays,
  ChartGantt,
  Columns3,
  Download,
  Gauge,
  Kanban,
  Layers,
  List,
  Plus,
  Repeat,
  Rows3,
  Search,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useNow } from "@/core/ui/useNow";
import { deleteWorkView, moveTask, saveWorkView } from "../actions";
import type { WorkData } from "../queries";
import type { TaskStatus, WorkView as SavedView, WorkViewFilters } from "../schema";
import { Board, type Flags } from "./Board";
import { CalendarView } from "./CalendarView";
import { CycleHeader, CyclesView, nextCycleFor } from "./CyclePanel";
import { CycleStrip } from "./CycleStrip";
import { ListView } from "./ListView";
import { ModuleHeader, ModulesView } from "./ModulesView";
import { MyWork } from "./MyWork";
import { PlaneImport } from "./PlaneImport";
import { QuickCreate } from "./QuickCreate";
import { Timeline } from "./Timeline";
import { WorkItemDetail } from "./WorkItemDetail";
import { readPref, writePref } from "./prefs";
import { isClosed } from "./work-ui";

const DAY = 86_400_000;

// ── URL state ──────────────────────────────────────────────────────────────

type Tab = "items" | "cycles" | "modules" | "timeline" | "mywork" | "overview";
type Layout = "board" | "list" | "calendar";
const LAYOUTS: Layout[] = ["board", "list", "calendar"];

/**
 * Tab + detail selection live in the URL (?tab=modules&module=…) so a module or
 * cycle page is linkable. A project page opens on its Overview (the cockpit);
 * the all-work page opens on Work items. My work (every project) is all-work only.
 */
function useWorkUrl(hasOverview: boolean, hasMyWork: boolean) {
  const sp = useSearchParams();
  const raw = sp.get("tab");
  const tabs: Tab[] = [
    "items",
    "cycles",
    "modules",
    "timeline",
    ...(hasMyWork ? (["mywork"] as Tab[]) : []),
    ...(hasOverview ? (["overview"] as Tab[]) : []),
  ];
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

// ── header ─────────────────────────────────────────────────────────────────

/** What the host puts in the Work header (a project page passes its own). */
export interface WorkHead {
  crumb: ReactNode;
  title: ReactNode;
  chips?: ReactNode;
  /** Extra buttons, left of "Ask" and "New item". */
  actions?: ReactNode;
  askLabel: string;
  askQuery: string;
  /** Under the title row (a project's description). */
  about?: ReactNode;
}

function Header({ head, onNew }: { head: WorkHead; onNew: () => void }) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-ink-faint">{head.crumb}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
            <h2 className="font-display text-[26px] font-semibold leading-tight tracking-[0.02em] text-ink">{head.title}</h2>
            {head.chips}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          {head.actions}
          <Link href={`/m/ask?q=${encodeURIComponent(head.askQuery)}`} className="wk-btn" title="A cited answer over everything linked here">
            <Sparkles className="size-3.5 text-ion" />
            {head.askLabel}
          </Link>
          <button type="button" onClick={onNew} className="wk-btn primary">
            <Plus className="size-3.5 text-plasma" />
            New item <kbd className="wk-kbd">C</kbd>
          </button>
        </div>
      </div>
      {head.about}
    </header>
  );
}

// ── the view ───────────────────────────────────────────────────────────────

type ViewId = Layout | "timeline" | "mywork";
const HINT: Record<ViewId, string> = {
  board: "drag cards between columns",
  list: "grouped by state · sorted by priority",
  calendar: "items on their due dates",
  timeline: "drag a bar to reschedule",
  mywork: "everything open, across all projects",
};

/**
 * The Work surface — one component for /m/tasks (all work) and a project page
 * (scoped, with an Overview tab for the cockpit). A header with the project's
 * status and actions, the cycle strip (progress, burndown, milestones, a read
 * of pace and risk), a view bar (Board · List · Calendar · Timeline · My work
 * with filter chips), and the item drawer docked on the right.
 */
export function WorkView({
  data,
  projectId,
  overview,
  head,
}: {
  data: WorkData;
  projectId?: string;
  overview?: ReactNode;
  head?: WorkHead;
}) {
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
  const { tab, moduleId, cycleId, go } = useWorkUrl(!!overview, !projectId);

  const prefKey = projectId ? "work.layout.project" : "work.layout.all";
  const [layout, setLayout] = useState<Layout>("board");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered layout after hydration (localStorage is client-only)
  useEffect(() => setLayout(readPref<Layout>(prefKey, "board", LAYOUTS)), [prefKey]);
  const pickLayout = (v: Layout) => {
    setLayout(v);
    writePref(prefKey, v);
  };

  // Board density: comfortable (full cards) or compact (one row per item).
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
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const identifierOf = useMemo(() => new Map(data.items.map((t) => [t.id, t.identifier ?? "blocked"])), [data.items]);
  const flags: Flags = useMemo(() => {
    const blockerOf = new Map<string, string>();
    for (const d of data.deps) if (!blockerOf.has(d.to)) blockerOf.set(d.to, identifierOf.get(d.from) ?? "blocked");
    return { blocked: new Set(data.blocked), blockerOf, delegated: data.delegated, commits: data.commits };
  }, [data.blocked, data.deps, data.delegated, data.commits, identifierOf]);
  const currentCycles = useMemo(() => new Set(data.cycles.filter((c) => c.status === "current").map((c) => c.id)), [data.cycles]);

  const openModule = moduleId ? data.features.find((f) => f.id === moduleId) : undefined;
  const openCycle = cycleId ? data.cycles.find((c) => c.id === cycleId) : undefined;
  // The item surface shows on Work items and on a module / cycle page.
  const itemSurface = tab === "items" || !!openModule || !!openCycle;
  const workSurface = itemSurface || tab === "timeline" || tab === "mywork";
  const scopeFeature = openModule?.id ?? feature;
  const scopeCycle = openCycle?.id ?? cycle;
  const view: ViewId = tab === "timeline" ? "timeline" : tab === "mywork" ? "mywork" : layout;

  // "C" opens New item; Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (creating) return;
      if (e.key === "Escape" && openId && !typing) setOpenId(null);
      else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, creating]);

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
    const was = items.find((t) => t.id === id);
    setItems((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, status, sortOrder, completedAt: isClosed(status) ? (t.completedAt ?? new Date(now)) : null } : t,
      ),
    );
    startMove(async () => {
      const r = await act(() => moveTask(id, status, sortOrder), { failed: "Couldn't move the item" });
      if (!r.ok && was) setItems((prev) => prev.map((t) => (t.id === id ? was : t)));
      refresh();
    });
  };

  const pickView = (v: ViewId) => {
    if (v === "timeline") return go({ tab: "timeline", module: null, cycle: null });
    if (v === "mywork") return projectId ? router.push("/m/tasks?tab=mywork") : go({ tab: "mywork", module: null, cycle: null });
    pickLayout(v);
    if (tab !== "items" && !openModule && !openCycle) go({ tab: "items" });
  };

  const liveFeatures = data.features.filter((f) => f.status === "planned" || f.status === "active" || f.status === "paused");
  const openItems = items.filter((t) => !isClosed(t.status));
  const sections: { id: Tab; label: string; icon: typeof List; count?: number; active: boolean }[] = [
    ...(overview ? [{ id: "overview" as Tab, label: "Overview", icon: Gauge, active: tab === "overview" }] : []),
    { id: "items", label: "Work items", icon: Kanban, count: openItems.length, active: workSurface && !openModule && !openCycle },
    { id: "cycles", label: "Cycles", icon: Repeat, count: data.cycles.filter((c) => c.status !== "completed").length, active: tab === "cycles" },
    { id: "modules", label: "Modules", icon: Layers, count: liveFeatures.length, active: tab === "modules" },
  ];

  // The all-work page's own header; a project page passes its own.
  const overdue = openItems.filter((t) => t.dueAt && +new Date(t.dueAt) + DAY < now).length;
  const inReview = openItems.filter((t) => t.status === "review").length;
  const header: WorkHead = head ?? {
    crumb: "Work / All projects",
    title: "All work",
    chips: (
      <>
        <span className="wk-chip">
          <span className="font-mono tabular-nums text-ink">{openItems.length}</span> open
        </span>
        {overdue > 0 && (
          <span className="wk-chip" style={{ color: "var(--color-flare)", borderColor: "color-mix(in oklab, var(--color-flare) 35%, transparent)" }}>
            <span className="dot" />
            {overdue} overdue
          </span>
        )}
        {inReview > 0 && (
          <span className="wk-chip" style={{ color: "var(--color-violet)", borderColor: "color-mix(in oklab, var(--color-violet) 35%, transparent)" }}>
            <span className="dot" />
            {inReview} in review
          </span>
        )}
        <button type="button" onClick={() => setPlaneOpen(true)} className="wk-chip transition hover:text-ink" title="One-time import from a Plane workspace">
          <Download className="size-3" /> Plane · import
        </button>
      </>
    ),
    askLabel: "Ask about my work",
    askQuery: "Across all my projects: what is overdue, blocked or waiting on review, and what should I do next?",
  };

  const viewTabs: { id: ViewId; label: string; icon: typeof List }[] = [
    { id: "board", label: "Board", icon: Columns3 },
    { id: "list", label: "List", icon: List },
    { id: "calendar", label: "Calendar", icon: CalendarDays },
    { id: "timeline", label: "Timeline", icon: ChartGantt },
    ...(openModule || openCycle ? [] : [{ id: "mywork" as ViewId, label: "My work · all projects", icon: UserRound }]),
  ];
  const showFilters = view !== "mywork";
  const featureForNew = openModule?.id ?? (feature && feature !== "none" ? feature : null);

  const drawer = openId && (
    <>
      <div className="fixed inset-0 z-40 bg-void/60 backdrop-blur-sm lg:hidden" onClick={() => setOpenId(null)} aria-hidden />
      <aside
        aria-label="Work item"
        className="wk-drawer fixed inset-y-0 right-0 z-50 flex w-full max-w-[430px] flex-col overflow-y-auto lg:sticky lg:top-3 lg:z-auto lg:max-h-[calc(100dvh-1.5rem)] lg:w-[430px] lg:shrink-0 lg:rounded-2xl"
      >
        <WorkItemDetail
          key={openId}
          id={openId}
          projects={data.projects}
          onChanged={refresh}
          onOpenItem={setOpenId}
          onDeleted={() => setOpenId(null)}
          onClose={() => setOpenId(null)}
        />
      </aside>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <Header head={header} onNew={() => setCreating(true)} />

      <nav className="-mx-1 flex items-center gap-1 overflow-x-auto border-b wk-line px-1" role="tablist" aria-label="Sections">
        {sections.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.active}
            onClick={() => go({ tab: t.id, module: null, cycle: null })}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition",
              t.active ? "border-plasma text-ink" : "border-transparent text-ink-faint hover:text-ink-dim",
            )}
          >
            <t.icon className={cn("size-3.5", t.active && "text-plasma")} />
            {t.label}
            {t.count != null && t.count > 0 && <span className="font-mono text-[11px] tabular-nums text-ink-faint">{t.count}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && overview}

      {tab === "modules" && !openModule && (
        <ModulesView features={data.features} items={items} projects={data.projects} projectId={projectId} onOpen={(id) => go({ module: id })} />
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

      {workSurface && !openModule && !openCycle && (
        <CycleStrip
          data={data}
          items={items}
          onOpenCycle={(id) => go({ tab: "cycles", cycle: id })}
          onOpenModule={(id) => go({ tab: "modules", module: id })}
          onOpenItem={setOpenId}
          onPlanCycle={() => go({ tab: "cycles" })}
        />
      )}

      {workSurface && (
        <>
          {tab === "items" && (
            <SavedViews views={data.views} current={currentFilters} projectId={projectId ?? null} onApply={applyView} onChanged={refresh} />
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="wk-tabs overflow-x-auto" role="tablist" aria-label="Views">
              {viewTabs.map((v) => (
                <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => pickView(v.id)}>
                  <v.icon className="size-3.5" />
                  {v.label}
                </button>
              ))}
            </div>
            {showFilters && (
              <>
                <label className={cn("wk-filter flex items-center gap-1.5 !cursor-text", q && "set")}>
                  <Search className="size-3.5 text-ink-faint" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Filter…"
                    aria-label="Filter items"
                    className="w-24 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint focus:w-36"
                  />
                  {q && (
                    <button type="button" onClick={() => setQ("")} aria-label="Clear filter">
                      <X className="size-3 text-ink-faint" />
                    </button>
                  )}
                </label>
                {!openCycle && data.cycles.length > 0 && (
                  <select value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label="Cycle" className={cn("wk-filter", cycle && "set")}>
                    <option value="">Cycle: any</option>
                    {currentCycles.size > 0 && <option value="current">Cycle: current</option>}
                    <option value="none">Cycle: none</option>
                    {data.cycles.map((c) => (
                      <option key={c.id} value={c.id}>
                        Cycle: {c.name}
                      </option>
                    ))}
                  </select>
                )}
                {allLabels.length > 0 && (
                  <select value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" className={cn("wk-filter", label && "set")}>
                    <option value="">Labels: any</option>
                    {allLabels.map((l) => (
                      <option key={l} value={l}>
                        Label: {l}
                      </option>
                    ))}
                  </select>
                )}
                {!projectId && (
                  <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={cn("wk-filter", project && "set")}>
                    <option value="">Project: all</option>
                    <option value="none">Project: none</option>
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        Project: {p.key && p.key !== p.name ? `${p.key} · ` : ""}
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                {!openModule && data.features.length > 0 && (
                  <select value={feature} onChange={(e) => setFeature(e.target.value)} aria-label="Module" className={cn("wk-filter", feature && "set")}>
                    <option value="">Module: any</option>
                    <option value="none">Module: none</option>
                    {liveFeatures.map((f) => (
                      <option key={f.id} value={f.id}>
                        Module: {f.name}
                      </option>
                    ))}
                  </select>
                )}
                {view === "board" && (
                  <button
                    type="button"
                    onClick={toggleCompact}
                    aria-pressed={compact}
                    title={compact ? "Comfortable cards" : "Compact cards — one row per item"}
                    className={cn("wk-filter inline-flex items-center gap-1.5", compact && "set")}
                  >
                    <Rows3 className="size-3.5" /> Compact
                  </button>
                )}
              </>
            )}
            <div className="flex-1" />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              {HINT[view]}
              {showFilters && (
                <>
                  {" · "}
                  <span className="tabular-nums">{filtered.filter((t) => !isClosed(t.status)).length}</span> open
                </>
              )}
            </span>
          </div>

          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              {view === "board" && (
                <Board items={filtered} all={items} flags={flags} selectedId={openId} onOpen={setOpenId} onMove={onMove} compact={compact} />
              )}
              {view === "list" && (
                <ListView items={filtered} data={data} flags={flags} showProject={!projectId} selectedId={openId} onOpen={setOpenId} />
              )}
              {view === "calendar" && <CalendarView items={filtered} onOpen={setOpenId} />}
              {view === "timeline" && (
                <Timeline
                  items={filtered}
                  features={projectId ? data.features : data.features.filter((f) => f.status !== "shipped")}
                  projects={data.projects}
                  deps={data.deps}
                  byFeature={!!projectId}
                  selectedId={openId}
                  onOpen={setOpenId}
                  onOpenModule={(id) => go({ tab: "modules", module: id })}
                />
              )}
              {view === "mywork" && <MyWork data={data} flags={flags} selectedId={openId} onOpen={setOpenId} />}
            </div>
            {drawer}
          </div>
        </>
      )}

      <QuickCreate
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={setOpenId}
        data={data}
        projectId={projectId}
        featureId={featureForNew}
        cycleId={openCycle?.id ?? null}
      />

      {planeOpen && <PlaneImport onClose={() => setPlaneOpen(false)} />}
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
      const r = await act(() => saveWorkView(projectId, name, current), { failed: "Couldn't save the view" });
      if (!r.ok) return;
      setName("");
      setNaming(false);
      onChanged();
    });

  const on = { color: "var(--color-plasma)", borderColor: "color-mix(in oklab, var(--color-plasma) 45%, transparent)" };
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Saved views">
      <Bookmark className="size-3.5 text-ink-faint" />
      <button type="button" onClick={() => onApply({ layout: current.layout })} className="wk-chip transition hover:text-ink" style={!filtered ? on : undefined}>
        Everything
      </button>
      {views.map((v) => (
        <span key={v.id} className="wk-chip group !pr-1" style={active?.id === v.id ? on : undefined}>
          <button type="button" onClick={() => onApply(v.filters)} className="transition hover:text-ink">
            {v.name}
          </button>
          <button
            type="button"
            aria-label={`Delete view ${v.name}`}
            title="Delete this view"
            onClick={() =>
              start(async () => {
                const r = await act(() => deleteWorkView(v.id), { failed: "Couldn't delete the view" });
                if (!r.ok) return;
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
        <button type="button" onClick={() => setNaming(true)} className="wk-chip border-dashed transition hover:text-ink">
          <Plus className="size-3" /> Save view
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
            className="wk-chip w-36 bg-transparent text-ink outline-none placeholder:text-ink-faint focus:border-plasma/50"
          />
          <button type="submit" disabled={pending || !name.trim()} className="wk-chip disabled:opacity-40" style={on}>
            Save
          </button>
        </form>
      )}
    </div>
  );
}
