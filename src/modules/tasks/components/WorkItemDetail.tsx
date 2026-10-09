"use client";

import { act as runAction, done, errorText, failed, resultError } from "@/core/ui/feedback";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
  ArrowUpRight,
  Bot,
  Box,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleDot,
  Copy,
  CornerDownRight,
  Flag,
  FolderKanban,
  GitBranch,
  GitCommitHorizontal,
  Hash,
  Layers,
  Pencil,
  Plus,
  Repeat,
  Signal,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { Markdown } from "@/core/ui/Markdown";
import { timeAgo } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import {
  addTaskComment,
  createTask,
  delegateTask,
  deleteTask,
  deleteTaskAttachment,
  loadWorkItem,
  relateTask,
  unrelateTask,
  updateTask,
} from "../actions";
import type { WorkItemPatch } from "../core";
import { AttachButton, AttachmentList, Lightbox } from "./Attachments";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskAttachment, type TaskPriority, type TaskStatus } from "../schema";
import { ESTIMATES, PRIORITY_META, RELATION_SIDE_LABEL, STATUS_META, displayTitle, plainTitle, type RelationSide } from "../states";
import type { WorkProject } from "../queries";
import { LabelPill, PriorityGlyph, StateGlyph, Who, branchName, dueTone, isClosed, splitTitle } from "./work-ui";

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
const actorIsBot = (a: string) => a !== "user";

const FIELD_LABEL: Record<string, string> = {
  title: "the title",
  status: "the state",
  priority: "the priority",
  dueAt: "the due date",
  startAt: "the start date",
  projectRef: "the project",
  featureRef: "the module",
  parentId: "the parent",
  estimate: "the estimate",
  labels: "the labels",
  notes: "the description",
  cycleId: "the cycle",
};

const RELATION_SIDES = Object.keys(RELATION_SIDE_LABEL) as RelationSide[];
const RELATION_GLYPH: Record<RelationSide, string> = {
  blocked_by: "⛓",
  blocks: "→",
  relates: "↔",
  duplicates: "≡",
  duplicated_by: "≡",
};

/** Human wording for an activity row's new value (states and priorities by label, dates short). */
function valueText(field: string | null, v: string | null): string {
  if (!v) return "";
  if (field === "status" && v in STATUS_META) return STATUS_META[v as TaskStatus].label;
  if (field === "priority" && v in PRIORITY_META) return PRIORITY_META[v as TaskPriority].label;
  if ((field === "dueAt" || field === "startAt") && !Number.isNaN(Date.parse(v)))
    return new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return v.length > 60 ? `${v.slice(0, 57)}…` : v;
}

function Sec({ title, count, action, children, className }: { title: string; count?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-b wk-line px-[18px] py-3.5", className)}>
      <h6 className="wk-sec-h mb-2">
        {title}
        {count != null && <span className="tabular-nums">· {count}</span>}
        {action && <span className="ml-auto normal-case tracking-normal">{action}</span>}
      </h6>
      {children}
    </section>
  );
}

/**
 * One work item, fully editable: a docked drawer on the Work views (or a full
 * page). Properties edit in place, the description renders as markdown, and
 * sub-items, relations, linked code and the activity stream sit below. Every
 * write goes through the core write path, so it lands in the history as "You".
 */
export function WorkItemDetail({
  id,
  projects,
  onChanged,
  onOpenItem,
  onDeleted,
  onClose,
  milestones,
  full = false,
}: {
  id: string;
  projects: WorkProject[];
  /** Called after any write so the host view can refresh its list. */
  onChanged?: () => void;
  /** Navigate to another item (sub-item / parent) inside the same host. */
  onOpenItem?: (id: string) => void;
  onDeleted?: () => void;
  /** Drawer only: close it. */
  onClose?: () => void;
  /** The item's milestones, rendered by the host (it holds the milestone data). */
  milestones?: ReactNode;
  full?: boolean;
}) {
  const now = useNow();
  const [data, setData] = useState<Loaded | null | undefined>(undefined);
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [comment, setComment] = useState("");
  const [subTitle, setSubTitle] = useState("");
  const [armedDelete, setArmedDelete] = useState(false);
  const [relSide, setRelSide] = useState<RelationSide>("blocked_by");
  const [relTarget, setRelTarget] = useState("");
  const [relating, setRelating] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [delegateNote, setDelegateNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<TaskAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const apply = useCallback((d: Loaded | null) => {
    setData(d);
    if (d) {
      setTitle(d.item.title);
      setNotes(d.item.notes ?? "");
    }
  }, []);
  const reload = useCallback(async () => {
    try {
      apply(await loadWorkItem(id));
    } catch (e) {
      failed("Couldn't reload the work item", errorText(e));
    }
  }, [apply, id]);

  useEffect(() => {
    let alive = true;
    loadWorkItem(id).then(
      (d) => alive && apply(d),
      (e) => alive && failed("Couldn't load the work item", errorText(e)),
    );
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
    el.style.height = `${Math.max(el.scrollHeight, 120)}px`;
  }, [notes, data, editingNotes]);

  const save = (patch: WorkItemPatch, saved?: string) => act(() => updateTask(id, patch), saved);
  /**
   * Any write: run it, surface a readable error, reload the item, tell the host.
   * `saved` confirms a write the page doesn't visibly reflect (a blur-save).
   */
  function act(fn: () => Promise<unknown>, saved?: string) {
    start(async () => {
      setError(null);
      try {
        const err = resultError(await fn());
        if (err) setError(err);
        else if (saved) done(saved);
      } catch (e) {
        setError(errorText(e));
      }
      await reload();
      onChanged?.();
    });
  }

  const closeBtn = onClose && (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-faint transition hover:bg-ink/8 hover:text-ink"
    >
      <X className="size-4" />
    </button>
  );

  if (data === undefined) {
    return (
      <div className="flex items-center justify-between p-[18px]">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">loading…</p>
        {closeBtn}
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="flex items-center justify-between p-[18px]">
        <p className="font-mono text-[10px] uppercase tracking-widest text-flare">item not found — it may have been deleted</p>
        {closeBtn}
      </div>
    );
  }

  const { item, children, parent, activity, features, relations, links, cycles, attachments } = data;
  const itemFiles = attachments.filter((a) => !a.commentId);
  const commentFiles = Map.groupBy(attachments.filter((a) => a.commentId), (a) => a.commentId!);
  const removeFile = (a: TaskAttachment) =>
    start(async () => {
      const r = await runAction(() => deleteTaskAttachment(a.id), { failed: `Couldn't remove ${a.name}` });
      if (r.ok) await reload();
    });
  const isOpen = !isClosed(item.status);
  const commits = links.filter((l) => l.kind === "commit");
  const runs = links.filter((l) => l.kind === "workbench");
  const liveRun = runs.find((r) => r.state !== "done" && r.state !== "cancelled");
  const projectId = item.projectRef?.startsWith("projects:") ? item.projectRef.slice(9) : "";
  const project = projects.find((p) => p.id === projectId);
  const featureId = item.featureRef?.startsWith("features:") ? item.featureRef.slice(9) : "";
  const doneChildren = children.filter((c) => isClosed(c.status)).length;
  const tone = dueTone(item, now);
  const { tag } = splitTitle(plainTitle(item.title));
  const branch = branchName(item.identifier, splitTitle(displayTitle(item)).text);
  const askQuery = `${item.identifier ?? ""} "${plainTitle(item.title).slice(0, 140)}" — what's the context, what's related, and what's the next step?`;

  const copyBranch = async () => {
    try {
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      failed("Couldn't copy the branch name");
    }
  };

  const addLabels = () => {
    const add = labelDraft.split(/[,\s]+/).map((l) => l.replace(/^#/, "").toLowerCase()).filter(Boolean);
    setLabelDraft("");
    const next = [...new Set([...item.labels, ...add])];
    if (next.length !== item.labels.length) save({ labels: next });
  };

  // ── pieces ──

  const headEl = (
    <div className={cn("flex items-start gap-2", !full && "border-b wk-line px-[18px] pb-2.5 pt-4")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-ink-faint">
          <span className="text-ink-dim">{item.identifier ?? "—"}</span>
          {project && <span>· {project.name}</span>}
          {tag && <span className="truncate">· {tag}</span>}
          {!full && (
            <Link href={`/m/tasks/${item.id}`} className="inline-flex items-center gap-0.5 transition hover:text-ink" title="Open as a page">
              · page <ArrowUpRight className="size-3" />
            </Link>
          )}
        </div>
        {parent && (
          <button
            type="button"
            onClick={() => onOpenItem?.(parent.id)}
            className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-ink-faint transition hover:text-ion"
            title="Open parent"
          >
            <CornerDownRight className="size-3 shrink-0 rotate-180" />
            <span className="font-mono">{parent.identifier}</span>
            <span className="truncate">{displayTitle(parent)}</span>
          </button>
        )}
        <textarea
          ref={titleRef}
          dir="auto"
          rows={1}
          value={title}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
          onBlur={() => title.trim() && title.trim() !== item.title && save({ title }, "Title saved")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          aria-label="Title"
          className={cn(
            "-mx-1 mt-1 w-[calc(100%+0.5rem)] resize-none overflow-hidden rounded-lg bg-transparent px-1 py-0.5 font-display font-semibold leading-[1.3] text-ink outline-none transition [text-wrap:balance] hover:bg-ink/4 focus:bg-ink/6",
            full ? "text-2xl" : "text-lg",
          )}
        />
      </div>
      {closeBtn}
    </div>
  );

  const propRow = (icon: ReactNode, label: string, value: ReactNode) => (
    <>
      <dt>
        {icon}
        {label}
      </dt>
      <dd>{value}</dd>
    </>
  );
  const ic = "size-3.5 shrink-0";

  const propertiesEl = (
    <dl className={cn("wk-props", !full && "border-b wk-line px-[18px] py-3.5")}>
      {propRow(
        <CircleDot className={ic} />,
        "State",
        <>
          <StateGlyph s={item.status} />
          <select value={item.status} onChange={(e) => save({ status: e.target.value as TaskStatus })} className="wk-inline" aria-label="State">
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </select>
        </>,
      )}
      {propRow(
        <Signal className={ic} />,
        "Priority",
        <>
          <PriorityGlyph p={item.priority} />
          <select value={item.priority} onChange={(e) => save({ priority: e.target.value as TaskPriority })} className="wk-inline" aria-label="Priority">
            {[...TASK_PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </select>
        </>,
      )}
      {propRow(
        <User className={ic} />,
        "Owner",
        liveRun ? (
          <>
            <Who bot />
            <span className="text-ink">Workbench run</span>
            <span className="font-mono text-[11px] text-ink-faint">{(liveRun.state ?? "queued").replace("_", " ")}</span>
          </>
        ) : (
          <>
            <Who />
            <span className="text-ink">You</span>
          </>
        ),
      )}
      {propRow(
        <Hash className={ic} />,
        "Labels",
        <>
          {item.labels.map((l) => (
            <span key={l} className="group/l relative inline-flex">
              <LabelPill l={l} />
              <button
                type="button"
                onClick={() => save({ labels: item.labels.filter((x) => x !== l) })}
                aria-label={`Remove label ${l}`}
                className="absolute -right-1.5 -top-1.5 hidden size-3.5 place-items-center rounded-full bg-panel text-ink-faint ring-1 ring-ion/20 hover:text-flare group-hover/l:grid focus-visible:grid"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
          <input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={addLabels}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLabels();
              }
            }}
            placeholder={item.labels.length ? "+ label" : "Add labels…"}
            aria-label="Add labels"
            className="wk-inline w-20 focus:w-32"
          />
        </>,
      )}
      {(cycles.length > 0 || item.cycleId) &&
        propRow(
          <Repeat className={ic} />,
          "Cycle",
          <select value={item.cycleId ?? ""} onChange={(e) => save({ cycleId: e.target.value || null })} className="wk-inline" aria-label="Cycle">
            <option value="">None</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === "current" ? " (current)" : c.status === "completed" ? " (completed)" : ""}
              </option>
            ))}
          </select>,
        )}
      {projectId &&
        propRow(
          <Layers className={ic} />,
          "Module",
          <select value={featureId} onChange={(e) => save({ featureRef: e.target.value ? `features:${e.target.value}` : null })} className="wk-inline" aria-label="Module">
            <option value="">None</option>
            {features.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.status === "shipped" ? " (shipped)" : ""}
              </option>
            ))}
          </select>,
        )}
      {milestones && projectId && propRow(<Flag className={ic} />, "Milestones", milestones)}
      {propRow(
        <FolderKanban className={ic} />,
        "Project",
        <select value={projectId} onChange={(e) => save({ projectRef: e.target.value ? `projects:${e.target.value}` : null })} className="wk-inline" aria-label="Project">
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key && p.key !== p.name ? `${p.key} · ` : ""}
              {p.name}
            </option>
          ))}
        </select>,
      )}
      {propRow(
        <Box className={ic} />,
        "Estimate",
        <>
          <select
            value={item.estimate ?? ""}
            onChange={(e) => save({ estimate: e.target.value ? Number(e.target.value) : null })}
            className="wk-inline"
            aria-label="Estimate"
          >
            <option value="">None</option>
            {ESTIMATES.map((n) => (
              <option key={n} value={n}>
                {n} pt{n === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </>,
      )}
      {propRow(
        <CalendarPlus className={ic} />,
        "Start",
        <input type="date" value={toDateInput(item.startAt)} onChange={(e) => save({ startAt: fromDateInput(e.target.value) })} aria-label="Start date" className="wk-inline" />,
      )}
      {propRow(
        <CalendarClock className={ic} />,
        "Due",
        <input
          type="date"
          value={toDateInput(item.dueAt)}
          onChange={(e) => save({ dueAt: fromDateInput(e.target.value) })}
          aria-label="Due date"
          className={cn("wk-inline", tone === "late" && "!text-flare", tone === "soon" && "!text-solar")}
        />,
      )}
    </dl>
  );

  const errorEl = error && <p className="mx-[18px] mt-3 rounded-lg bg-flare/8 px-3 py-2 text-xs text-flare">{error}</p>;

  const descriptionEl = (
    <Sec
      title="Description"
      action={
        !editingNotes &&
        item.notes && (
          <button
            type="button"
            onClick={() => setEditingNotes(true)}
            className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
          >
            <Pencil className="size-3" /> edit
          </button>
        )
      }
    >
      {editingNotes ? (
        <textarea
          ref={notesRef}
          autoFocus
          dir="auto"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            setEditingNotes(false);
            if (notes.trim() !== (item.notes ?? "").trim()) save({ notes }, "Description saved");
          }}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
          placeholder="Markdown — **bold**, lists, links, `code`…"
          className="max-h-[60vh] min-h-28 w-full resize-y rounded-lg bg-ink/4 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink-dim outline-none placeholder:text-ink-faint focus:bg-ink/6"
        />
      ) : item.notes ? (
        <div
          className="max-h-[42vh] cursor-text overflow-y-auto [&_p]:!text-[13px]"
          onDoubleClick={() => setEditingNotes(true)}
          title="Double-click to edit"
        >
          <Markdown>{item.notes}</Markdown>
        </div>
      ) : (
        <button type="button" onClick={() => setEditingNotes(true)} className="text-[13px] text-ink-faint transition hover:text-ink-dim">
          Add a description…
        </button>
      )}
    </Sec>
  );

  const subitemsEl = (
    <Sec title="Sub-items" count={children.length ? `${doneChildren}/${children.length}` : undefined}>
      <div className="flex flex-col">
        {children.map((c) => {
          const cDone = isClosed(c.status);
          return (
            <div key={c.id} className="group flex items-center gap-2 py-[3px] text-[13px]">
              <input
                type="checkbox"
                checked={cDone}
                onChange={() => act(() => updateTask(c.id, { status: cDone ? "todo" : "done" }))}
                aria-label={cDone ? `Reopen ${c.identifier}` : `Complete ${c.identifier}`}
                className="size-3.5 shrink-0 accent-[var(--color-plasma)]"
              />
              <button type="button" onClick={() => onOpenItem?.(c.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{c.identifier}</span>
                <span className={cn("truncate transition group-hover:text-ink", cDone ? "text-ink-faint line-through" : "text-ink-dim")}>{displayTitle(c)}</span>
              </button>
            </div>
          );
        })}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = subTitle.trim();
            if (!t) return;
            start(async () => {
              const r = await runAction(() => createTask({ title: t, parentId: item.id }), { failed: "Couldn't add the sub-item" });
              if (!r.ok) return;
              setSubTitle("");
              await reload();
              onChanged?.();
            });
          }}
          className="flex items-center gap-2 py-[3px]"
        >
          <Plus className="size-3.5 shrink-0 text-ink-faint" />
          <input
            value={subTitle}
            onChange={(e) => setSubTitle(e.target.value)}
            placeholder="Add sub-item…"
            aria-label="Add sub-item"
            className="h-7 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
        </form>
      </div>
    </Sec>
  );

  const relationsEl = (
    <Sec
      title="Relations & links"
      action={
        !relating && (
          <button
            type="button"
            onClick={() => setRelating(true)}
            className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
          >
            <Plus className="size-3" /> relate
          </button>
        )
      }
    >
      <div className="flex flex-col gap-0.5 text-[12.5px] text-ink-dim">
        {relations.map((rel) => {
          const live = rel.side === "blocked_by" && isOpen && !isClosed(rel.other.status);
          return (
            <div key={rel.id} className="group flex items-center gap-2 py-[3px]">
              <span className={cn("w-4 shrink-0 text-center", live ? "text-flare" : "text-ink-faint")}>{RELATION_GLYPH[rel.side]}</span>
              <span className={cn("shrink-0", live && "text-flare")}>{RELATION_SIDE_LABEL[rel.side]}</span>
              <button type="button" onClick={() => onOpenItem?.(rel.other.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition hover:text-ion">
                <b className="shrink-0 font-mono text-[11.5px] font-medium text-ink">{rel.other.identifier}</b>
                <span className="truncate">{displayTitle(rel.other)}</span>
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
          );
        })}
        {commits.map((l) => {
          const body = (
            <>
              <GitCommitHorizontal className="size-3.5 shrink-0 text-violet" />
              <span className="wk-link shrink-0">{l.ref.slice(0, 7)}</span>
              <span className="truncate">{l.title}</span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-faint">{timeAgo(l.createdAt, { compact: true })}</span>
            </>
          );
          return l.url ? (
            <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-[3px] transition hover:text-ink">
              {body}
            </a>
          ) : (
            <div key={l.id} className="flex items-center gap-2 py-[3px]">
              {body}
            </div>
          );
        })}
        {runs.map((l) => (
          <Link key={l.id} href={l.url ?? `/m/workbench/${l.ref}`} className="flex items-center gap-2 py-[3px] transition hover:text-ink">
            <Bot className="size-3.5 shrink-0 text-violet" />
            <span className="truncate">{l.title ?? "Workbench run"}</span>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-faint">{(l.state ?? "queued").replace("_", " ")}</span>
          </Link>
        ))}
        {!relations.length && !commits.length && !runs.length && <p className="py-[3px] text-ink-faint">No relations or linked code yet.</p>}
        {relating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!relTarget.trim()) return;
              act(async () => {
                const r = await relateTask(item.id, relSide, relTarget);
                if (r.ok) {
                  setRelTarget("");
                  setRelating(false);
                }
                return r;
              });
            }}
            className="mt-1 flex items-center gap-1.5"
          >
            <select value={relSide} onChange={(e) => setRelSide(e.target.value as RelationSide)} aria-label="Relation" className="wk-inline !ml-0 border-ion/20">
              {RELATION_SIDES.map((sd) => (
                <option key={sd} value={sd}>
                  {RELATION_SIDE_LABEL[sd]}
                </option>
              ))}
            </select>
            <input
              autoFocus
              value={relTarget}
              onChange={(e) => setRelTarget(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRelating(false)}
              placeholder={`item id, e.g. ${item.identifier ?? "KEY-4"}`}
              aria-label="Related item identifier"
              className="h-7 min-w-0 flex-1 rounded-md bg-ink/4 px-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint"
            />
          </form>
        )}
        <button
          type="button"
          onClick={copyBranch}
          title="Copy the suggested branch name — commits that mention the item id link back here"
          className="mt-1 flex items-center gap-2 py-[3px] text-left font-mono text-[11.5px] text-ink-faint transition hover:text-ink"
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">branch · {branch}</span>
          {copied ? <Check className="ml-auto size-3.5 shrink-0 text-plasma" /> : <Copy className="ml-auto size-3 shrink-0" />}
        </button>
      </div>
    </Sec>
  );

  const attachmentsEl = (
    <Sec
      title="Attachments"
      count={attachments.length || undefined}
      action={<AttachButton taskId={item.id} onDone={() => start(reload)} />}
    >
      {itemFiles.length ? (
        <AttachmentList items={itemFiles} onOpenImage={setLightbox} onDelete={removeFile} />
      ) : (
        <p className="text-[12px] text-ink-faint">
          {attachments.length ? "All files here are attached to comments below." : "Screenshots, logs, findings and evidence — kept for good, in Drive."}
        </p>
      )}
    </Sec>
  );

  const activityEl = (
    <Sec title="Activity">
      <ol className="flex flex-col gap-2.5">
        {activity.map((a) => (
          <li key={a.id} className="wk-ev">
            <Who bot={actorIsBot(a.actor)} title={actorLabel(a.actor)} />
            <div className="min-w-0">
              <time>{timeAgo(a.createdAt)}</time>
              {a.kind === "comment" ? (
                <>
                  <strong className="font-semibold text-ink">{actorLabel(a.actor)}</strong>
                  <div dir="auto" className="mt-1 rounded-lg bg-ink/4 px-2.5 py-1.5 text-[13px] leading-relaxed text-ink-dim">
                    <Markdown>{a.body ?? ""}</Markdown>
                    {commentFiles.has(a.id) && (
                      <AttachmentList items={commentFiles.get(a.id)!} onOpenImage={setLightbox} onDelete={removeFile} compact />
                    )}
                  </div>
                </>
              ) : (
                <span>
                  <strong className="font-semibold text-ink">{actorLabel(a.actor)}</strong>{" "}
                  {a.kind === "created" ? (
                    "created this item"
                  ) : a.kind === "attachment" ? (
                    <>
                      {a.field === "deleted" ? "removed" : a.field === "version" ? "added a new version of" : "attached"}{" "}
                      <span className="text-ink">{a.toValue}</span>
                    </>
                  ) : a.field === "notes" ? (
                    "edited the description"
                  ) : a.field === "relation" ? (
                    <>
                      marked this <span className="text-ink">{a.toValue}</span>
                    </>
                  ) : a.field === "status" && a.fromValue && a.toValue ? (
                    <>
                      moved {valueText("status", a.fromValue)} → <span className="text-ink">{valueText("status", a.toValue)}</span>
                    </>
                  ) : (
                    <>
                      {a.toValue ? "set" : "cleared"} {FIELD_LABEL[a.field ?? ""] ?? a.field}
                      {a.toValue && (
                        <>
                          {" "}
                          to <span className="text-ink">{valueText(a.field, a.toValue)}</span>
                        </>
                      )}
                    </>
                  )}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = comment.trim();
          if (!body) return;
          start(async () => {
            const r = await runAction(() => addTaskComment(item.id, body), { failed: "Couldn't post the comment" });
            if (!r.ok) return;
            setComment("");
            await reload();
          });
        }}
        className="mt-3 flex items-end gap-2"
      >
        <textarea
          dir="auto"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
          rows={1}
          placeholder="Leave a comment… (⌘↵)"
          aria-label="Comment"
          className="min-h-9 w-full resize-y rounded-lg bg-ink/4 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:bg-ink/6"
        />
        {comment.trim() && (
          <button type="submit" disabled={pending} className="wk-btn primary shrink-0 !px-2.5 !py-1.5 text-xs">
            Comment
          </button>
        )}
      </form>
    </Sec>
  );

  const handoffEl = isOpen && delegating && (
    <div className="mx-[18px] mt-3.5 flex flex-col gap-2 rounded-xl border border-violet/25 p-3">
      <p className="text-xs leading-relaxed text-ink-faint">
        A Workbench run gets the title, description{children.length ? " and open sub-items" : ""}. It works in an isolated copy of the
        project&apos;s repo (if one is attached), and the item moves to In review with a draft for you when it finishes.
      </p>
      <textarea
        autoFocus
        dir="auto"
        value={delegateNote}
        onChange={(e) => setDelegateNote(e.target.value)}
        rows={2}
        placeholder="Extra instructions (optional)"
        className="w-full resize-y rounded-lg bg-ink/4 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:bg-ink/6"
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
          className="wk-btn violet !py-1.5 text-xs"
        >
          <Bot className="size-3.5 text-violet" /> Start the run
        </button>
        <button type="button" onClick={() => setDelegating(false)} className="px-2 text-xs text-ink-faint transition hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );

  const deleteBtn = (
    // House rule: two-step armed delete, no browser confirm.
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
          const r = await runAction(() => deleteTask(item.id), { failed: "Couldn't delete the work item" });
          if (!r.ok) return;
          onChanged?.();
          onDeleted?.();
        });
      }}
      className={cn(
        "ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition",
        armedDelete ? "border border-flare/40 text-flare" : "text-ink-faint hover:text-flare",
      )}
      title="Delete this item"
    >
      <Trash2 className="size-3.5" />
      {armedDelete ? "Click again to delete" : "Delete"}
    </button>
  );

  const actionsEl = (
    <div className={cn("flex flex-wrap items-center gap-2", !full && "px-[18px] py-3.5")}>
      {isOpen && !liveRun && !delegating && (
        <button
          type="button"
          onClick={() => setDelegating(true)}
          className="wk-btn primary"
          title="A background executor works on this item; the result comes back for your review"
        >
          <Bot className="size-3.5 text-plasma" /> Delegate to Workbench → draft PR
        </button>
      )}
      <Link href={`/m/ask?q=${encodeURIComponent(askQuery)}`} className="wk-btn">
        <Sparkles className="size-3.5 text-ion" /> Ask about this
      </Link>
      {deleteBtn}
    </div>
  );

  // A full page gets two columns — the content on the left, the properties
  // rail on the right. The drawer keeps one column.
  if (full) {
    return (
      <div className={cn("flex flex-col gap-5", pending && "opacity-80")}>
        {headEl}
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8">
          <aside className="wk-drawer flex flex-col gap-4 rounded-2xl p-4 lg:sticky lg:top-4 lg:order-2">
            {propertiesEl}
            {actionsEl}
            {handoffEl}
            {errorEl}
          </aside>
          <div className="glass min-w-0 overflow-hidden rounded-2xl lg:order-1 [&>section:last-child]:border-b-0">
            {descriptionEl}
            {attachmentsEl}
            {subitemsEl}
            {relationsEl}
            {activityEl}
          </div>
        </div>
        <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", pending && "opacity-80")}>
      {headEl}
      {propertiesEl}
      {errorEl}
      {handoffEl}
      {descriptionEl}
      {attachmentsEl}
      {subitemsEl}
      {relationsEl}
      {activityEl}
      {actionsEl}
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
