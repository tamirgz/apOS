"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, Check, ChevronDown, Layers, Pencil, Plus, Rocket, Trash2, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import { createFeature, deleteFeature, updateFeature } from "@/modules/projects/features-actions";
import type { FeatureStatus } from "@/modules/projects/schema";
import { delegateFeatureAction } from "../actions";
import type { WorkItem } from "../core";
import type { WorkFeature, WorkProject } from "../queries";

export const FEATURE_META: Record<FeatureStatus, { label: string; color: string }> = {
  planned: { label: "Planned", color: "var(--color-ink-faint)" },
  active: { label: "Active", color: "var(--color-solar)" },
  paused: { label: "Paused", color: "var(--color-ink-faint)" },
  shipped: { label: "Shipped", color: "var(--color-plasma)" },
  cancelled: { label: "Cancelled", color: "var(--color-ink-faint)" },
};
const FEATURE_STATUSES = Object.keys(FEATURE_META) as FeatureStatus[];

export interface FeatureProgress {
  total: number;
  closed: number;
  open: number;
}

export function featureProgress(items: WorkItem[]): Map<string, FeatureProgress> {
  const m = new Map<string, FeatureProgress>();
  for (const t of items) {
    if (!t.featureRef?.startsWith("features:")) continue;
    const id = t.featureRef.slice(9);
    const p = m.get(id) ?? { total: 0, closed: 0, open: 0 };
    p.total++;
    if (t.status === "done" || t.status === "cancelled") p.closed++;
    else p.open++;
    m.set(id, p);
  }
  return m;
}

const toDateInput = (d: Date | string | null) => {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

function TargetLabel({ f }: { f: WorkFeature }) {
  const now = useNow();
  if (!f.targetAt) return null;
  const late = f.status !== "shipped" && +new Date(f.targetAt) < now;
  return (
    <span className={cn("font-mono text-[10px] tabular-nums", late ? "text-flare" : "text-ink-faint")} title="Target date">
      {late ? "late · " : "→ "}
      {shortDate(f.targetAt)}
    </span>
  );
}

function Bar({ p }: { p?: FeatureProgress }) {
  const pct = p && p.total ? Math.round((p.closed / p.total) * 100) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/6" aria-hidden>
      <div className="h-full rounded-full bg-plasma/70 transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

function FeatureRow({
  f,
  p,
  active,
  onSelect,
}: {
  f: WorkFeature;
  p?: FeatureProgress;
  active: boolean;
  onSelect: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(f.name);
  const [armed, setArmed] = useState(false);
  const [armedRun, setArmedRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      router.refresh();
    });

  if (editing) {
    return (
      <div className="glass flex flex-wrap items-center gap-2 rounded-xl p-2.5">
        <input
          dir="auto"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Feature name"
          className="min-w-40 flex-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-sm text-ink outline-none focus:bg-white/8"
        />
        <select
          value={f.status}
          onChange={(e) => run(() => updateFeature(f.id, f.projectId, { status: e.target.value as FeatureStatus }))}
          aria-label="Status"
          className="rounded-lg border border-white/8 bg-panel px-2 py-1.5 text-xs text-ink-dim outline-none"
        >
          {FEATURE_STATUSES.map((s) => (
            <option key={s} value={s}>{FEATURE_META[s].label}</option>
          ))}
        </select>
        <input
          type="date"
          value={toDateInput(f.targetAt)}
          onChange={(e) =>
            run(() => updateFeature(f.id, f.projectId, { targetAt: e.target.value ? new Date(`${e.target.value}T18:00:00`) : null }))
          }
          aria-label="Target date"
          className="rounded-lg border border-white/8 bg-transparent px-2 py-1.5 text-xs text-ink-dim outline-none"
        />
        <button
          type="button"
          onClick={() =>
            run(async () => {
              if (name.trim() && name.trim() !== f.name) await updateFeature(f.id, f.projectId, { name });
              setEditing(false);
            })
          }
          className="rounded-lg p-1.5 text-plasma transition hover:bg-plasma/10"
          aria-label="Done editing"
        >
          <Check className="size-4" />
        </button>
        {(p?.open ?? 0) > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!armedRun) {
                setArmedRun(true);
                setTimeout(() => setArmedRun(false), 4000);
                return;
              }
              run(async () => {
                await delegateFeatureAction(f.id);
                setEditing(false);
              });
            }}
            className={cn(
              "flex items-center gap-1 rounded-lg px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
              armedRun ? "border border-violet/40 text-violet" : "text-ink-faint hover:text-violet",
            )}
            title="One Workbench run takes all the feature's open items; they move to In review when it finishes"
          >
            <Bot className="size-3.5" />
            {armedRun ? `again to hand ${p!.open} item${p!.open === 1 ? "" : "s"} over` : "workbench"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (!armed) {
              setArmed(true);
              setTimeout(() => setArmed(false), 3000);
              return;
            }
            run(() => deleteFeature(f.id, f.projectId));
          }}
          className={cn(
            "flex items-center gap-1 rounded-lg px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
            armed ? "border border-flare/40 text-flare" : "text-ink-faint hover:text-flare",
          )}
          title="Delete feature (its items stay in the project)"
        >
          <Trash2 className="size-3.5" />
          {armed && "again to delete"}
        </button>
        {error && <p className="w-full text-xs text-flare">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border px-3 py-2 transition",
        active ? "border-ion/40 bg-ion/8" : "border-white/6 hover:border-white/12 hover:bg-white/3",
        pending && "opacity-50",
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left" title={active ? "Show all items" : "Show only this feature's items"}>
        <span
          className="shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest"
          style={{ color: FEATURE_META[f.status].color, borderColor: "color-mix(in oklab, currentColor 35%, transparent)" }}
        >
          {FEATURE_META[f.status].label}
        </span>
        <span dir="auto" className="min-w-0 truncate text-sm text-ink-dim transition group-hover:text-ink">{f.name}</span>
        <span className="ml-auto flex w-40 shrink-0 items-center gap-2">
          <Bar p={p} />
          <span className="font-mono text-[10px] tabular-nums text-ink-faint">
            {p?.closed ?? 0}/{p?.total ?? 0}
          </span>
        </span>
      </button>
      <TargetLabel f={f} />
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-md p-1 text-ink-faint opacity-0 transition hover:text-ink group-hover:opacity-100 focus:opacity-100"
        aria-label={`Edit ${f.name}`}
      >
        <Pencil className="size-3.5" />
      </button>
    </div>
  );
}

function ShippedLog({ features, progress }: { features: WorkFeature[]; progress: Map<string, FeatureProgress> }) {
  const [open, setOpen] = useState(false);
  if (!features.length) return null;
  const sorted = [...features].sort((a, b) => +new Date(b.shippedAt ?? 0) - +new Date(a.shippedAt ?? 0));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 px-1 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint transition hover:text-ink-dim"
      >
        <Rocket className="size-3 text-plasma" />
        shipped <span className="tabular-nums">{features.length}</span>
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <ol className="mt-1 flex flex-col border-l border-white/6 pl-3">
          {sorted.map((f) => (
            <li key={f.id} className="flex items-baseline gap-3 py-1 text-sm">
              <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
                {f.shippedAt ? shortDate(f.shippedAt) : "—"}
              </span>
              <span dir="auto" className="text-ink-dim">{f.name}</span>
              <span className="font-mono text-[10px] text-ink-faint">
                {progress.get(f.id)?.total ?? 0} items
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A project's features: what's being built now (planned / active / paused) as
 * compact progress rows — click one to filter the board to it — and a folded
 * "shipped" log instead of finished features squatting on the page forever.
 */
export function FeatureStrip({
  projectId,
  features,
  items,
  selected,
  onSelect,
}: {
  projectId: string;
  features: WorkFeature[];
  items: WorkItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const progress = featureProgress(items);
  const live = features.filter((f) => f.status === "planned" || f.status === "active" || f.status === "paused");
  const shipped = features.filter((f) => f.status === "shipped");

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center gap-2 px-1">
        <Layers className="size-3.5 text-solar" />
        <h2 className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">features</h2>
        <span className="font-mono text-xs tabular-nums text-ink-faint">{live.length}</span>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="ml-2 inline-flex items-center gap-1 rounded-md bg-ion/12 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ion"
          >
            filtered <X className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:bg-white/5 hover:text-ink"
        >
          <Plus className="size-3" /> feature
        </button>
      </header>
      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            start(async () => {
              await createFeature(projectId, name);
              setName("");
              setAdding(false);
              router.refresh();
            });
          }}
          className="glass flex items-center gap-2 rounded-xl p-1.5 pl-3"
        >
          <input
            autoFocus
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            placeholder="Feature name — e.g. Offline sync"
            disabled={pending}
            className="h-8 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <button type="submit" disabled={pending} className="rounded-lg bg-solar/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-solar hover:bg-solar/25">
            add
          </button>
        </form>
      )}
      {live.length === 0 && !adding ? (
        <p className="px-1 text-xs text-ink-faint">
          Nothing in build. Group related items into a feature to track it to shipped.
        </p>
      ) : (
        live.map((f) => (
          <FeatureRow
            key={f.id}
            f={f}
            p={progress.get(f.id)}
            active={selected === f.id}
            onSelect={() => onSelect(selected === f.id ? null : f.id)}
          />
        ))
      )}
      <ShippedLog features={shipped} progress={progress} />
    </section>
  );
}

/** Cross-project roadmap: every feature in build, grouped by project, plus what shipped lately. */
export function FeatureRoadmap({
  features,
  items,
  projects,
}: {
  features: WorkFeature[];
  items: WorkItem[];
  projects: WorkProject[];
}) {
  const now = useNow();
  const progress = featureProgress(items);
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const live = features.filter((f) => f.status === "planned" || f.status === "active" || f.status === "paused");
  const recent = features.filter(
    (f) => f.status === "shipped" && f.shippedAt && now - +new Date(f.shippedAt) < 30 * 86_400_000,
  );
  const groups = new Map<string, WorkFeature[]>();
  for (const f of live) groups.set(f.projectId, [...(groups.get(f.projectId) ?? []), f]);

  return (
    <div className="flex flex-col gap-6">
      {groups.size === 0 && (
        <p className="glass rounded-xl px-4 py-6 text-center text-sm text-ink-faint">
          No features in build. Add one from a project page to track it here.
        </p>
      )}
      {[...groups.entries()].map(([pid, fs]) => (
        <section key={pid} className="flex flex-col gap-2">
          <Link
            href={`/m/projects/${pid}`}
            className="flex w-fit items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint transition hover:text-ink"
          >
            <span className="text-ink-dim">{byProject.get(pid)?.key}</span>
            {byProject.get(pid)?.name ?? "Unknown project"}
          </Link>
          {fs.map((f) => (
            <div key={f.id} className="flex items-center gap-3 rounded-xl border border-white/6 px-3 py-2">
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest" style={{ color: FEATURE_META[f.status].color }}>
                {FEATURE_META[f.status].label}
              </span>
              <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-ink-dim">{f.name}</span>
              <span className="flex w-40 shrink-0 items-center gap-2">
                <Bar p={progress.get(f.id)} />
                <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                  {progress.get(f.id)?.closed ?? 0}/{progress.get(f.id)?.total ?? 0}
                </span>
              </span>
              <span className="w-20 text-right"><TargetLabel f={f} /></span>
            </div>
          ))}
        </section>
      ))}
      {recent.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            <Rocket className="size-3 text-plasma" /> shipped in the last 30 days
          </h3>
          {recent
            .sort((a, b) => +new Date(b.shippedAt!) - +new Date(a.shippedAt!))
            .map((f) => (
              <div key={f.id} className="flex items-baseline gap-3 px-1 py-0.5 text-sm">
                <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{shortDate(f.shippedAt!)}</span>
                <span className="font-mono text-[10px] text-ink-faint">{byProject.get(f.projectId)?.key}</span>
                <span dir="auto" className="text-ink-dim">{f.name}</span>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
