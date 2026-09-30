"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { ArrowUpRight, Bot, CornerDownRight, GitCommitHorizontal, Layers, Link2, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { timeAgo } from "@/core/ui/time";
import {
  addTaskComment,
  createTask,
  delegateTask,
  deleteTask,
  loadWorkItem,
  relateTask,
  unrelateTask,
  updateTask,
} from "../actions";
import type { WorkItemPatch } from "../core";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "../schema";
import { ESTIMATES, PRIORITY_META, RELATION_SIDE_LABEL, STATUS_META, displayTitle, plainTitle, type RelationSide } from "../states";
import type { WorkProject } from "../queries";

type Loaded = NonNullable<Awaited<ReturnType<typeof loadWorkItem>>>;

/** Local-date input value — toISOString() shifts the day across UTC. */
function toDateInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
const fromDateInput = (v: string) => (v ? new Date(`${v}T18:00:00`) : null);

const actorLabel = (a: string) =>
  a === "user" ? "You" : a.startsWith("agent:") ? a.slice(6) : a.startsWith("system:") ? a.slice(7) : a === "agent" ? "An agent" : a;

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  status: "state",
  priority: "priority",
  dueAt: "due date",
  startAt: "start date",
  projectRef: "project",
  featureRef: "feature",
  parentId: "parent",
  estimate: "estimate",
  labels: "labels",
  notes: "description",
  cycleId: "cycle",
};

const RELATION_SIDES = Object.keys(RELATION_SIDE_LABEL) as RelationSide[];

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

const control =
  "w-full rounded-lg border border-white/8 bg-panel px-2.5 py-1.5 text-xs text-ink-dim outline-none transition hover:border-white/16 focus:border-ion/40";

/**
 * One work item, fully editable: properties, description, sub-items, and the
 * activity + comment stream. Every field saves on change/blur through the
 * core write path, so each edit lands in the history with "You" as the actor.
 */
export function WorkItemDetail({
  id,
  projects,
  onChanged,
  onOpenItem,
  onDeleted,
  full = false,
}: {
  id: string;
  projects: WorkProject[];
  /** Called after any write so the host view can refresh its list. */
  onChanged?: () => void;
  /** Navigate to another item (sub-item / parent) inside the same host. */
  onOpenItem?: (id: string) => void;
  onDeleted?: () => void;
  full?: boolean;
}) {
  const [data, setData] = useState<Loaded | null | undefined>(undefined);
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [labels, setLabels] = useState("");
  const [comment, setComment] = useState("");
  const [subTitle, setSubTitle] = useState("");
  const [armedDelete, setArmedDelete] = useState(false);
  const [relSide, setRelSide] = useState<RelationSide>("blocked_by");
  const [relTarget, setRelTarget] = useState("");
  const [delegating, setDelegating] = useState(false);
  const [delegateNote, setDelegateNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const apply = useCallback((d: Loaded | null) => {
    setData(d);
    if (d) {
      setTitle(d.item.title);
      setNotes(d.item.notes ?? "");
      setLabels(d.item.labels.join(", "));
    }
  }, []);
  const reload = useCallback(async () => apply(await loadWorkItem(id)), [apply, id]);

  useEffect(() => {
    let alive = true;
    loadWorkItem(id).then((d) => alive && apply(d));
    return () => {
      alive = false;
    };
  }, [apply, id]);

  // The title wraps (long imported titles were cut off in a single-line input).
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title, data]);

  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 96)}px`;
  }, [notes, data]);

  const save = (patch: WorkItemPatch) => act(() => updateTask(id, patch));
  /** Any write: run it, surface a readable error, reload the item, tell the host. */
  function act(fn: () => Promise<unknown>) {
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      await reload();
      onChanged?.();
    });
  }

  if (data === undefined) {
    return <p className="p-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">loading…</p>;
  }
  if (data === null) {
    return <p className="p-2 font-mono text-[10px] uppercase tracking-widest text-flare">item not found — it may have been deleted</p>;
  }

  const { item, children, parent, activity, features, relations, links, cycles } = data;
  const isOpen = item.status !== "done" && item.status !== "cancelled";
  const commits = links.filter((l) => l.kind === "commit");
  const runs = links.filter((l) => l.kind === "workbench");
  const projectId = item.projectRef?.startsWith("projects:") ? item.projectRef.slice(9) : "";
  const featureId = item.featureRef?.startsWith("features:") ? item.featureRef.slice(9) : "";
  const doneChildren = children.filter((c) => c.status === "done" || c.status === "cancelled").length;

  const identityEl = (
    <>
        {/* identity */}
        <div className="flex flex-col gap-2">
          <div className={cn("flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint", !full && "pr-9")}>
            <span className="text-ink-dim">{item.identifier ?? "—"}</span>
            {parent && (
              <button
                type="button"
                onClick={() => onOpenItem?.(parent.id)}
                className="inline-flex items-center gap-1 normal-case tracking-normal transition hover:text-ion"
                title="Open parent"
              >
                <CornerDownRight className="size-3 rotate-180" />
                {parent.identifier} {displayTitle(parent)}
              </button>
            )}
            {!full && (
              <Link
                href={`/m/tasks/${item.id}`}
                className="ml-auto inline-flex items-center gap-1 transition hover:text-ink"
                title="Open as a page"
              >
                page <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
          <textarea
            ref={titleRef}
            dir="auto"
            rows={1}
            value={title}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
            onBlur={() => title.trim() && title.trim() !== item.title && save({ title })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            aria-label="Title"
            className="w-full resize-none overflow-hidden rounded-lg bg-transparent px-1 py-1 font-display text-xl font-semibold leading-snug text-ink outline-none transition hover:bg-white/4 focus:bg-white/6"
          />
          {displayTitle(item) !== plainTitle(item.title) && (
            <p className="px-1 text-xs text-ink-faint" title="A shortened form made by a local model; the title above is unchanged">
              <span className="font-mono text-[9px] uppercase tracking-widest">in lists</span>{" "}
              {displayTitle(item)}
            </p>
          )}
        </div>
    </>
  );
  const propertiesEl = (
    <>
        {/* properties */}
        <div className="flex flex-col gap-2">
          <Prop label="State">
            <select
              value={item.status}
              onChange={(e) => save({ status: e.target.value as TaskStatus })}
              className={control}
              style={{ color: STATUS_META[item.status].color }}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </Prop>
          <Prop label="Priority">
            <select
              value={item.priority}
              onChange={(e) => save({ priority: e.target.value as TaskPriority })}
              className={cn(control, PRIORITY_META[item.priority].className)}
            >
              {[...TASK_PRIORITIES].reverse().map((p) => (
                <option key={p} value={p}>{PRIORITY_META[p].label}</option>
              ))}
            </select>
          </Prop>
          <Prop label="Estimate">
            <select
              value={item.estimate ?? ""}
              onChange={(e) => save({ estimate: e.target.value ? Number(e.target.value) : null })}
              className={control}
            >
              <option value="">none</option>
              {ESTIMATES.map((n) => (
                <option key={n} value={n}>{n} pt{n === 1 ? "" : "s"}</option>
              ))}
            </select>
          </Prop>
          <Prop label="Labels">
            <input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              onBlur={() => {
                const next = labels.split(/[,\s]+/).filter(Boolean);
                if (next.join(",") !== item.labels.join(",")) save({ labels: next });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              placeholder="comma separated"
              className={control}
            />
          </Prop>
          <Prop label="Dates">
            <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 [&>input]:min-w-0 [&>input]:flex-1 [&>input]:basis-32", full && "lg:[&>span]:hidden")}>
              <input
                type="date"
                value={toDateInput(item.startAt)}
                onChange={(e) => save({ startAt: fromDateInput(e.target.value) })}
                aria-label="Start date"
                title="Start"
                className={control}
              />
              <span className="text-ink-faint">→</span>
              <input
                type="date"
                value={toDateInput(item.dueAt)}
                onChange={(e) => save({ dueAt: fromDateInput(e.target.value) })}
                aria-label="Due date"
                title="Due"
                className={control}
              />
            </div>
          </Prop>
          <Prop label="Project">
            <select
              value={projectId}
              onChange={(e) => save({ projectRef: e.target.value ? `projects:${e.target.value}` : null })}
              className={control}
            >
              <option value="">no project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key ? `${p.key} · ` : ""}{p.name}
                </option>
              ))}
            </select>
          </Prop>
          {projectId && (
            <Prop label="Feature">
              <select
                value={featureId}
                onChange={(e) => save({ featureRef: e.target.value ? `features:${e.target.value}` : null })}
                className={control}
              >
                <option value="">none</option>
                {features.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}{f.status === "shipped" ? " (shipped)" : ""}
                  </option>
                ))}
              </select>
            </Prop>
          )}
          {(cycles.length > 0 || item.cycleId) && (
            <Prop label="Cycle">
              <select value={item.cycleId ?? ""} onChange={(e) => save({ cycleId: e.target.value || null })} className={control}>
                <option value="">none</option>
                {cycles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.status === "current" ? " (current)" : c.status === "completed" ? " (completed)" : ""}
                  </option>
                ))}
              </select>
            </Prop>
          )}
        </div>
    </>
  );
  const errorEl = (
    <>
        {error && <p className="rounded-lg bg-flare/8 px-3 py-2 text-xs text-flare">{error}</p>}
    </>
  );
  const descriptionEl = (
    <>
        {/* description */}
        <textarea
          ref={notesRef}
          dir="auto"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes.trim() !== (item.notes ?? "") && save({ notes })}
          placeholder="Add a description…"
          className="max-h-[50vh] min-h-24 w-full resize-y rounded-lg bg-white/4 px-3 py-2 text-sm leading-relaxed text-ink-dim outline-none placeholder:text-ink-faint focus:bg-white/6"
        />
    </>
  );
  const handoffEl = (
    <>
        {/* Workbench hand-off */}
        {isOpen && (
          <section className="flex flex-col gap-2">
            {!delegating ? (
              <button
                type="button"
                onClick={() => setDelegating(true)}
                className="flex w-fit items-center gap-1.5 rounded-lg border border-violet/25 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-violet transition hover:bg-violet/10"
                title="A background executor works on this item; the result comes back for your review"
              >
                <Bot className="size-3.5" /> hand off as a run
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-violet/25 p-3">
                <p className="text-xs text-ink-faint">
                  The run gets the title, description{children.length ? " and open sub-items" : ""}. It runs in an isolated copy of the
                  project&apos;s repo (if one is attached) and the item moves to In review when it finishes.
                </p>
                <textarea
                  dir="auto"
                  value={delegateNote}
                  onChange={(e) => setDelegateNote(e.target.value)}
                  rows={2}
                  placeholder="Extra instructions (optional)"
                  className="w-full resize-y rounded-lg bg-white/4 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:bg-white/6"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      act(async () => {
                        await delegateTask(item.id, delegateNote);
                        setDelegating(false);
                        setDelegateNote("");
                      })
                    }
                    className="rounded-lg bg-violet/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-violet transition hover:bg-violet/25 disabled:opacity-40"
                  >
                    start run
                  </button>
                  <button type="button" onClick={() => setDelegating(false)} className="px-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint hover:text-ink">
                    cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
    </>
  );
  const subitemsEl = (
    <>
        {/* sub-items */}
        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            <Layers className="size-3" /> sub-items
            {children.length > 0 && <span className="tabular-nums">{doneChildren}/{children.length}</span>}
          </h3>
          {children.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpenItem?.(c.id)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition hover:bg-white/4"
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_META[c.status].color }} />
              <span className="font-mono text-[10px] text-ink-faint">{c.identifier}</span>
              <span className={cn("truncate", c.status === "done" || c.status === "cancelled" ? "text-ink-faint line-through" : "text-ink-dim")}>
                {displayTitle(c)}
              </span>
            </button>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = subTitle.trim();
              if (!t) return;
              start(async () => {
                await createTask({ title: t, parentId: item.id });
                setSubTitle("");
                await reload();
                onChanged?.();
              });
            }}
            className="flex items-center gap-2 rounded-md px-1.5"
          >
            <Plus className="size-3.5 text-ink-faint" />
            <input
              value={subTitle}
              onChange={(e) => setSubTitle(e.target.value)}
              placeholder="Add sub-item…"
              className="h-8 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </form>
        </section>
    </>
  );
  const relationsEl = (
    <>
        {/* relations */}
        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            <Link2 className="size-3" /> relations
          </h3>
          {relations.map((rel) => (
            <div key={rel.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-sm">
              <span className={cn("w-24 shrink-0 text-xs", rel.side === "blocked_by" && isOpen && rel.other.status !== "done" && rel.other.status !== "cancelled" ? "text-flare" : "text-ink-faint")}>
                {RELATION_SIDE_LABEL[rel.side]}
              </span>
              <button type="button" onClick={() => onOpenItem?.(rel.other.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left transition hover:text-ion">
                <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_META[rel.other.status].color }} />
                <span className="font-mono text-[10px] text-ink-faint">{rel.other.identifier}</span>
                <span className="truncate text-ink-dim">{displayTitle(rel.other)}</span>
              </button>
              <button
                type="button"
                onClick={() => act(() => unrelateTask(rel.id))}
                aria-label="Remove relation"
                className="rounded p-0.5 text-ink-faint opacity-0 transition hover:text-flare group-hover:opacity-100 focus:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!relTarget.trim()) return;
              act(async () => {
                await relateTask(item.id, relSide, relTarget);
                setRelTarget("");
              });
            }}
            className="flex items-center gap-2 px-1.5"
          >
            <select value={relSide} onChange={(e) => setRelSide(e.target.value as RelationSide)} aria-label="Relation" className="rounded-md border border-white/8 bg-panel px-1.5 py-1 text-xs text-ink-dim outline-none">
              {RELATION_SIDES.map((sd) => (
                <option key={sd} value={sd}>{RELATION_SIDE_LABEL[sd]}</option>
              ))}
            </select>
            <input
              value={relTarget}
              onChange={(e) => setRelTarget(e.target.value)}
              placeholder="item id, e.g. GL-4"
              aria-label="Related item identifier"
              className="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-faint"
            />
          </form>
        </section>
    </>
  );
  const evidenceEl = (
    <>
        {/* evidence: commits + Workbench runs */}
        {(commits.length > 0 || runs.length > 0) && (
          <section className="flex flex-col gap-1">
            <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
              <GitCommitHorizontal className="size-3" /> linked work
            </h3>
            {runs.map((l) => (
              <Link key={l.id} href={l.url ?? `/m/workbench/${l.ref}`} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition hover:bg-white/4">
                <Bot className="size-3.5 shrink-0 text-violet" />
                <span className="truncate text-ink-dim">{l.title ?? "Run"}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">{(l.state ?? "queued").replace("_", " ")}</span>
              </Link>
            ))}
            {commits.map((l) => {
              const body = (
                <>
                  <span className="shrink-0 font-mono text-[10px] text-ion">{l.ref.slice(0, 7)}</span>
                  <span className="truncate text-ink-dim">{l.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">{timeAgo(l.createdAt)}</span>
                </>
              );
              return l.url ? (
                <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition hover:bg-white/4">
                  {body}
                </a>
              ) : (
                <div key={l.id} className="flex items-center gap-2 px-1.5 py-1 text-sm">{body}</div>
              );
            })}
          </section>
        )}
    </>
  );
  const activityEl = (
    <>
        {/* activity + comments */}
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
            <MessageSquare className="size-3" /> activity
          </h3>
          <ol className="flex flex-col gap-1.5">
            {activity.map((a) =>
              a.kind === "comment" ? (
                <li key={a.id} className="rounded-lg bg-white/4 px-3 py-2">
                  <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-ink-faint">
                    <span className="text-ink-dim">{actorLabel(a.actor)}</span>
                    <span>{timeAgo(a.createdAt)}</span>
                  </div>
                  <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim">{a.body}</p>
                </li>
              ) : (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-1.5 px-1 text-xs text-ink-faint">
                  <span className="text-ink-dim">{actorLabel(a.actor)}</span>
                  {a.kind === "created" ? (
                    <span>created this</span>
                  ) : a.field === "notes" ? (
                    <span>edited the description</span>
                  ) : a.field === "relation" ? (
                    <span>
                      marked this <span className="text-ink-dim">{a.toValue}</span>
                    </span>
                  ) : (
                    <span>
                      {a.toValue ? "set" : "cleared"} {FIELD_LABEL[a.field ?? ""] ?? a.field}
                      {a.toValue && <> to <span className="text-ink-dim">{a.toValue}</span></>}
                    </span>
                  )}
                  <span className="font-mono text-[10px]">· {timeAgo(a.createdAt)}</span>
                </li>
              ),
            )}
          </ol>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const body = comment.trim();
              if (!body) return;
              start(async () => {
                await addTaskComment(item.id, body);
                setComment("");
                await reload();
              });
            }}
            className="flex flex-col gap-2"
          >
            <textarea
              dir="auto"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
              }}
              rows={2}
              placeholder="Leave a comment… (⌘↵)"
              className="w-full resize-y rounded-lg bg-white/4 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:bg-white/6"
            />
            <button
              type="submit"
              disabled={pending || !comment.trim()}
              className="self-end rounded-lg bg-plasma/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
            >
              comment
            </button>
          </form>
        </section>
    </>
  );
  const deleteEl = (
    <>
        {/* House rule: two-step armed delete, no browser confirm. */}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!armedDelete) {
              setArmedDelete(true);
              setTimeout(() => setArmedDelete(false), 3000);
              return;
            }
            start(async () => {
              await deleteTask(item.id);
              onChanged?.();
              onDeleted?.();
            });
          }}
          className={cn(
            "flex w-fit items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
            armedDelete ? "border border-flare/40 text-flare" : "text-ink-faint hover:text-flare",
          )}
        >
          <Trash2 className="size-3.5" />
          {armedDelete ? "click again to delete" : "delete"}
        </button>
    </>
  );

  // A full page gets two columns — the content on the left, the properties
  // rail (state, dates, hand-off, linked runs) on the right. The drawer keeps
  // the single column.
  if (full) {
    return (
      <div className={cn("flex flex-col gap-5", pending && "opacity-80")}>
        {identityEl}
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-8">
          <aside className="flex flex-col gap-5 lg:sticky lg:top-4 lg:order-2 lg:rounded-xl lg:border lg:border-white/6 lg:p-4">
            {propertiesEl}
            {errorEl}
            {handoffEl}
            {evidenceEl}
          </aside>
          <div className="flex min-w-0 flex-col gap-5 lg:order-1">
            {descriptionEl}
            {subitemsEl}
            {relationsEl}
            {activityEl}
            {deleteEl}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-5", pending && "opacity-80")}>
      {identityEl}
      {propertiesEl}
      {errorEl}
      {descriptionEl}
      {handoffEl}
      {subitemsEl}
      {relationsEl}
      {evidenceEl}
      {activityEl}
      {deleteEl}
    </div>
  );
}
