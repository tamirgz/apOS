"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { ArrowUpRight, CornerDownRight, Layers, MessageSquare, Plus, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { timeAgo } from "@/core/ui/time";
import {
  addTaskComment,
  createTask,
  deleteTask,
  loadWorkItem,
  updateTask,
} from "../actions";
import type { WorkItemPatch } from "../core";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "../schema";
import { ESTIMATES, PRIORITY_META, STATUS_META } from "../states";
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
};

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
  const notesRef = useRef<HTMLTextAreaElement>(null);

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

  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 96)}px`;
  }, [notes, data]);

  const save = (patch: WorkItemPatch) =>
    start(async () => {
      await updateTask(id, patch);
      await reload();
      onChanged?.();
    });

  if (data === undefined) {
    return <p className="p-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">loading…</p>;
  }
  if (data === null) {
    return <p className="p-2 font-mono text-[10px] uppercase tracking-widest text-flare">item not found — it may have been deleted</p>;
  }

  const { item, children, parent, activity, features } = data;
  const projectId = item.projectRef?.startsWith("projects:") ? item.projectRef.slice(9) : "";
  const featureId = item.featureRef?.startsWith("features:") ? item.featureRef.slice(9) : "";
  const doneChildren = children.filter((c) => c.status === "done" || c.status === "cancelled").length;

  return (
    <div className={cn("flex flex-col gap-5", pending && "opacity-80")}>
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
              {parent.identifier} {parent.title}
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
        <input
          dir="auto"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title.trim() !== item.title && save({ title })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Title"
          className="w-full rounded-lg bg-transparent px-1 py-1 font-display text-xl font-semibold leading-snug text-ink outline-none transition hover:bg-white/4 focus:bg-white/6"
        />
      </div>

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
          <div className="flex items-center gap-2">
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
      </div>

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
              {c.title}
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
    </div>
  );
}
