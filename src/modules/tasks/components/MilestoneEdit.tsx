"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, Diamond, Flag, MinusCircle, Plus, Search, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import type { WorkItem } from "../core";
import {
  addMilestoneContent,
  createMilestoneAction,
  searchMilestoneEntities,
  setMilestoneCriteria,
  updateMilestoneAction,
} from "../milestone-actions";
import { OUTLOOK_META, orderMilestones, type ContentInfo, type MilestoneBundle, type MilestoneInfo } from "../milestone-scope";
import type { WorkFeature } from "../queries";
import { STATUS_META } from "../states";
import { useMilestoneStats } from "./MilestonesView";

/** Run a milestone write with feedback, then refresh the page's data. */
export function useMilestoneWrite() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const write = <T,>(fn: () => Promise<T>, failed: string, after?: (v: T) => void) =>
    start(async () => {
      const r = await act(fn, { failed });
      if (!r.ok) return;
      after?.(r.value);
      router.refresh();
    });
  return { pending, write };
}

/** The project's items only — on all work the list spans every project. */
export const itemsOf = (items: WorkItem[], projectId: string) => items.filter((t) => t.projectRef === `projects:${projectId}`);

// ── new milestone ───────────────────────────────────────────────────────────

export function NewMilestone({ projectId, onCreated, onCancel }: { projectId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const { pending, write } = useMilestoneWrite();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        write(
          () => createMilestoneAction(projectId, name),
          "Couldn't create the milestone",
          (r) => r.ok && onCreated(r.id),
        );
      }}
      className="glass flex items-center gap-2 rounded-2xl p-2.5 pl-3.5"
    >
      <Flag className="size-[15px] shrink-0 text-ink-faint" aria-hidden />
      <input
        autoFocus
        dir="auto"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Milestone name, such as Visibility or MVP"
        aria-label="Milestone name"
        disabled={pending}
        className="h-8 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <button type="submit" disabled={pending || !name.trim()} className="wk-btn primary !py-1.5 text-xs">
        Create
      </button>
      <button type="button" onClick={onCancel} className="wk-btn !py-1.5 text-xs">
        Cancel
      </button>
    </form>
  );
}

// ── content picker ──────────────────────────────────────────────────────────

type PickTab = "modules" | "items" | "milestones" | "other";
const TABS: { id: PickTab; label: string }[] = [
  { id: "modules", label: "Modules" },
  { id: "items", label: "Items" },
  { id: "milestones", label: "Milestones" },
  { id: "other", label: "Other" },
];
type Pick = { kind: ContentInfo["kind"]; targetId: string; entityKind?: string; label?: string };
const keyOf = (p: { kind: string; targetId: string }) => `${p.kind}:${p.targetId}`;
const SHOWN = 80;

/**
 * Add content to one capability (or ungrouped): whole modules, single items,
 * other milestones, or anything else in apOS. "Leave out" takes modules or
 * items out of scope instead, e.g. a whole module except one item.
 */
export function ContentPicker({
  m,
  capabilityId,
  bundle,
  items,
  features,
  initialTab = "modules",
  onClose,
}: {
  m: MilestoneInfo;
  capabilityId: string | null;
  bundle: MilestoneBundle;
  items: WorkItem[];
  features: WorkFeature[];
  initialTab?: PickTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PickTab>(initialTab);
  const [q, setQ] = useState("");
  const [leaveOut, setLeaveOut] = useState(false);
  const [picked, setPicked] = useState<Map<string, Pick>>(() => new Map());
  const [found, setFound] = useState<{ kind: string; id: string; title: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const { pending, write } = useMilestoneWrite();

  const existing = useMemo(() => new Map(bundle.content.filter((r) => r.milestoneId === m.id).map((r) => [keyOf(r), r])), [bundle.content, m.id]);
  const wholeModules = useMemo(
    () => new Set(bundle.content.filter((r) => r.milestoneId === m.id && r.kind === "module" && !r.exclude).map((r) => r.targetId)),
    [bundle.content, m.id],
  );
  const featureName = useMemo(() => new Map(features.map((f) => [f.id, f.name])), [features]);
  const needle = q.trim().toLowerCase();

  // Entity search runs on the server (the search index), debounced.
  useEffect(() => {
    if (tab !== "other" || needle.length < 2) return;
    let live = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const rows = await searchMilestoneEntities(needle);
        if (live) setFound(rows);
      } finally {
        if (live) setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tab, needle]);

  const leaveOutable = tab === "modules" || tab === "items";
  const excluding = leaveOut && leaveOutable;
  const toggle = (p: Pick) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(keyOf(p))) next.delete(keyOf(p));
      else next.set(keyOf(p), p);
      return next;
    });
  const switchTab = (t: PickTab) => {
    setTab(t);
    setQ("");
  };

  type Option = { pick: Pick; title: string; meta?: string; dot?: string; note?: string };
  let options: Option[] = [];
  if (tab === "modules")
    options = features
      .filter((f) => f.projectId === m.projectId && (!needle || f.name.toLowerCase().includes(needle)))
      .map((f) => ({ pick: { kind: "module", targetId: f.id }, title: f.name, meta: f.status }));
  else if (tab === "items") {
    const order = ["doing", "review", "todo", "backlog", "done", "cancelled"];
    options = itemsOf(items, m.projectId)
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.identifier?.toLowerCase().includes(needle))
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
      .map((t) => {
        const mod = t.featureRef?.startsWith("features:") ? t.featureRef.slice(9) : null;
        return {
          pick: { kind: "item", targetId: t.id },
          title: t.shortTitle ?? t.title,
          meta: t.identifier ?? undefined,
          dot: STATUS_META[t.status].color,
          note: mod && wholeModules.has(mod) ? `in ${featureName.get(mod) ?? "a module"} already` : mod ? featureName.get(mod) : undefined,
        };
      });
  } else if (tab === "milestones")
    options = orderMilestones(bundle.milestones)
      .filter((x) => x.projectId === m.projectId && x.id !== m.id && (!needle || x.name.toLowerCase().includes(needle)))
      .map((x) => ({ pick: { kind: "milestone", targetId: x.id }, title: x.name, meta: x.status }));
  else
    options = (needle.length < 2 ? [] : found).map((e) => ({
      pick: { kind: "entity", targetId: e.id, entityKind: e.kind, label: e.title },
      title: e.title,
      meta: e.kind,
    }));

  const n = picked.size;
  const submit = () =>
    write(
      () =>
        addMilestoneContent(
          m.id,
          [...picked.values()].map((p) => ({ kind: p.kind, targetId: p.targetId, entityKind: p.entityKind ?? null, label: p.label ?? null })),
          excluding ? { exclude: true } : { capabilityId, exclude: false },
        ),
      excluding ? "Couldn't leave that out" : "Couldn't add the content",
      onClose,
    );

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-ion/15 bg-ink/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="wk-tabs" role="tablist" aria-label="What to add">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => switchTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {leaveOutable && (
          <button
            type="button"
            onClick={() => setLeaveOut(!leaveOut)}
            aria-pressed={leaveOut}
            title="Take the picked modules or items out of this milestone's scope"
            className={cn("wk-chip transition hover:text-ink", leaveOut && "!border-flare/45 text-flare")}
          >
            <MinusCircle className="size-3" /> Leave out
          </button>
        )}
        <button type="button" onClick={onClose} className="ml-auto rounded-md p-1 text-ink-faint transition hover:text-ink" aria-label="Close the picker">
          <X className="size-3.5" />
        </button>
      </div>
      <label className="wk-filter flex items-center gap-1.5 !cursor-text">
        <Search className="size-3.5 text-ink-faint" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          placeholder={tab === "other" ? "Search notes, docs, files, runs…" : tab === "items" ? "Filter by title or identifier…" : "Filter…"}
          aria-label="Search content"
          className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
      <ul className="-mx-1 flex max-h-72 flex-col overflow-y-auto" aria-label="Content to pick">
        {options.slice(0, SHOWN).map((o) => {
          const k = keyOf(o.pick);
          const has = existing.get(k);
          const on = picked.has(k);
          return (
            <li key={k}>
              <button
                type="button"
                disabled={!!has}
                onClick={() => toggle(o.pick)}
                aria-pressed={on}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition enabled:hover:bg-ink/[0.05] disabled:opacity-50",
                  on && "bg-plasma/[0.08]",
                )}
              >
                <span
                  className={cn("grid size-3.5 shrink-0 place-items-center rounded-[4px] border", on ? "border-plasma bg-plasma text-void" : "border-ink-faint/60")}
                  aria-hidden
                >
                  {on && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                {o.pick.kind === "module" && <Diamond className="size-3 shrink-0 text-solar" fill="currentColor" fillOpacity={0.25} aria-hidden />}
                {o.pick.kind === "milestone" && <Flag className="size-3 shrink-0 text-ink-faint" aria-hidden />}
                {o.dot && <span className="size-2 shrink-0 rounded-full" style={{ background: o.dot }} aria-hidden />}
                {o.meta && <span className="w-[70px] shrink-0 truncate font-mono text-[10.5px] uppercase tracking-wider text-ink-faint">{o.meta}</span>}
                <span dir="auto" className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {o.title}
                </span>
                {has ? (
                  <span className="shrink-0 text-[10.5px] text-ink-faint">{has.exclude ? "left out" : "in scope"}</span>
                ) : (
                  o.note && <span className="max-w-[40%] shrink-0 truncate text-[10.5px] text-ink-faint">{o.note}</span>
                )}
              </button>
            </li>
          );
        })}
        {options.length === 0 && (
          <li className="px-2 py-3 text-[12px] text-ink-faint">
            {tab === "other"
              ? needle.length < 2
                ? "Type at least two letters to search everything else in apOS."
                : searching
                  ? "Searching…"
                  : "Nothing matches."
              : needle
                ? "Nothing matches."
                : `This project has no ${tab === "milestones" ? "other milestones" : tab}.`}
          </li>
        )}
        {options.length > SHOWN && <li className="px-2 py-1.5 text-[11px] text-ink-faint">{options.length - SHOWN} more — filter to narrow it down.</li>}
      </ul>
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-ink-faint">
          {n ? `${n} picked` : excluding ? "Pick what to leave out of scope." : "Pick what this delivers."}
        </span>
        <button
          type="button"
          disabled={!n || pending}
          onClick={submit}
          className={cn("wk-btn ml-auto !py-1 text-xs", excluding ? "!border-flare/45 text-flare" : "primary")}
        >
          {excluding ? <MinusCircle className="size-3.5" /> : <Plus className="size-3.5" />}
          {excluding ? `Leave out ${n || ""}` : `Add ${n || ""}`}
        </button>
      </div>
    </div>
  );
}

// ── exit criteria ───────────────────────────────────────────────────────────

export function CriteriaEditor({ m }: { m: MilestoneInfo }) {
  const [draft, setDraft] = useState("");
  const { pending, write } = useMilestoneWrite();
  const save = (next: { id?: string; text: string; done: boolean }[], failed: string, after?: () => void) =>
    write(() => setMilestoneCriteria(m.id, next), failed, after);
  return (
    <div className={cn("flex flex-col gap-1.5", pending && "opacity-70")}>
      <ul className="flex flex-col gap-1">
        {m.criteria.map((c) => (
          <li key={c.id} className="group flex items-start gap-2 text-[13px]">
            <button
              type="button"
              onClick={() => save(m.criteria.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)), "Couldn't update the criterion")}
              aria-label={c.done ? `Mark "${c.text}" as not met` : `Mark "${c.text}" as met`}
              className="mt-0.5 shrink-0 rounded transition hover:scale-110"
            >
              {c.done ? <Check className="size-3.5 text-plasma" /> : <Circle className="size-3.5 text-ink-faint" />}
            </button>
            <span dir="auto" className={cn("min-w-0 flex-1", c.done ? "text-ink-dim" : "text-ink")}>
              {c.text}
            </span>
            <button
              type="button"
              onClick={() => save(m.criteria.filter((x) => x.id !== c.id), "Couldn't remove the criterion")}
              aria-label={`Remove "${c.text}"`}
              className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-flare focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          save([...m.criteria, { text: draft, done: false }], "Couldn't add the criterion", () => setDraft(""));
        }}
      >
        <input
          dir="auto"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="+ Add a criterion, such as “A real tenant connected”"
          aria-label="New exit criterion"
          className="wk-inline w-full !px-1 text-[12.5px]"
        />
      </form>
    </div>
  );
}

// ── requires ────────────────────────────────────────────────────────────────

/** The milestones that must be reached first: chips with a remove, plus a picker. */
export function RequiresEditor({ m, bundle }: { m: MilestoneInfo; bundle: MilestoneBundle }) {
  const { pending, write } = useMilestoneWrite();
  const byId = new Map(bundle.milestones.map((x) => [x.id, x]));
  const options = orderMilestones(bundle.milestones).filter((x) => x.projectId === m.projectId && x.id !== m.id && !m.requires.includes(x.id));
  const save = (requires: string[]) => write(() => updateMilestoneAction(m.id, { requires }), "Couldn't change what it waits on");
  return (
    <span className={cn("flex flex-wrap items-center gap-1.5", pending && "opacity-70")}>
      {m.requires.map((id) => (
        <span key={id} className="wk-chip group !py-px !pr-1 !text-[11.5px]">
          {byId.get(id)?.name ?? "Deleted milestone"}
          <button
            type="button"
            onClick={() => save(m.requires.filter((x) => x !== id))}
            aria-label={`Stop waiting on ${byId.get(id)?.name ?? "it"}`}
            className="rounded-full p-0.5 text-ink-faint transition hover:text-flare"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      {options.length > 0 && (
        <select value="" onChange={(e) => e.target.value && save([...m.requires, e.target.value])} aria-label="Add a milestone it waits on" className="wk-inline text-ink-faint">
          <option value="">{m.requires.length ? "+ another" : "Nothing — add one…"}</option>
          {options.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {!options.length && !m.requires.length && <span className="text-ink-faint">Nothing</span>}
    </span>
  );
}

// ── the drawer chip ─────────────────────────────────────────────────────────

/**
 * An item's milestones in the drawer — the ones whose scope it's in (directly,
 * through its module, or through a nested milestone) — and a picker to add it
 * to another of its project's milestones as a single item.
 */
export function ItemMilestones({
  itemId,
  bundle,
  items,
  onOpen,
}: {
  itemId: string;
  bundle: MilestoneBundle;
  items: WorkItem[];
  onOpen: (id: string) => void;
}) {
  const { resolve, stats } = useMilestoneStats(bundle, items);
  const { pending, write } = useMilestoneWrite();
  const item = items.find((t) => t.id === itemId);
  const projectId = item?.projectRef?.startsWith("projects:") ? item.projectRef.slice(9) : null;
  const mine = orderMilestones(bundle.milestones.filter((m) => m.projectId === projectId && m.status !== "cancelled"));
  const inScope = mine.filter((m) => resolve(m.id).items.some((x) => x.item.id === itemId));
  const addable = mine.filter((m) => m.status !== "done" && !inScope.includes(m));
  if (!projectId || (!inScope.length && !addable.length)) return <span className="text-ink-faint">None</span>;
  return (
    <span className={cn("flex flex-wrap items-center gap-1.5", pending && "opacity-70")}>
      {inScope.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onOpen(m.id)}
          className="wk-chip !py-px !text-[11.5px] transition hover:text-ink"
          title={`${OUTLOOK_META[stats.get(m.id)?.outlook ?? "unscheduled"].label} · ${stats.get(m.id)?.pct ?? 0}% delivered`}
        >
          <Flag className="size-3" style={{ color: OUTLOOK_META[stats.get(m.id)?.outlook ?? "unscheduled"].color }} aria-hidden />
          {m.name}
        </button>
      ))}
      {addable.length > 0 && (
        <select
          value=""
          onChange={(e) =>
            e.target.value &&
            write(() => addMilestoneContent(e.target.value, [{ kind: "item", targetId: itemId }]), "Couldn't add it to the milestone")
          }
          aria-label="Add to a milestone"
          className="wk-inline text-ink-faint"
        >
          <option value="">{inScope.length ? "+ milestone" : "Add to a milestone…"}</option>
          {addable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}
