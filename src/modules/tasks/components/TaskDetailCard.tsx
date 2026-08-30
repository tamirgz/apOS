"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Flame, FolderKanban, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { deleteTask, setTaskStatus, updateTask } from "../actions";
import { TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from "../schema";

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: "text-flare",
  medium: "text-solar",
  low: "text-ink-faint",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "queue",
  doing: "in flight",
  done: "landed",
};

/** Local-date input value — toISOString() shifted the day across UTC. */
function toDateInput(d: Date | string | null): string {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** The full-page edit surface — same fields as the board's modal, permalink-able. */
export function TaskDetailCard({
  task,
  projectOptions,
}: {
  task: Task;
  projectOptions: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueAt, setDueAt] = useState(toDateInput(task.dueAt));
  const [projectId, setProjectId] = useState(task.projectRef?.split(":")[1] ?? "");
  const [saved, setSaved] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = () => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(autoGrow, []);

  const projectName = projectOptions.find((p) => p.id === projectId)?.name;

  const save = () => {
    const t = title.trim();
    if (!t) return;
    start(async () => {
      await updateTask(task.id, {
        title: t,
        notes: notes.trim() || null,
        priority,
        dueAt: dueAt ? new Date(dueAt) : null,
        projectRef: projectId ? `projects:${projectId}` : null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      router.refresh();
    });
  };

  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TASK_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await setTaskStatus(task.id, s);
                router.refresh();
              })
            }
            className={cn(
              "rounded-lg border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
              task.status === s
                ? "border-plasma/40 text-plasma"
                : "border-white/8 text-ink-faint hover:border-white/20 hover:text-ink-dim",
            )}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
        {projectId && projectName && (
          <Link
            href={`/m/projects/${projectId}`}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 font-mono text-[10px] tracking-wide text-ink-dim transition hover:border-solar/40 hover:text-solar"
          >
            <FolderKanban className="size-3" />
            {projectName}
          </Link>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        }}
        placeholder="Title"
        className="mb-2 w-full rounded-lg bg-white/5 px-3 py-2 text-base text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
      />

      <textarea
        ref={notesRef}
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        }}
        rows={4}
        placeholder="Notes…"
        className="mb-3 max-h-[50vh] min-h-[6rem] w-full resize-y overflow-y-auto rounded-lg bg-white/5 px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setPriority((p) => (p === "medium" ? "high" : p === "high" ? "low" : "medium"))
          }
          title={`Priority: ${priority} (click to cycle)`}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition hover:bg-white/5",
            PRIORITY_STYLE[priority],
          )}
        >
          <Flame className="size-3.5" />
          {priority}
        </button>
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="rounded-lg border border-white/8 bg-transparent px-2.5 py-1.5 text-xs text-ink-dim outline-none"
        />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/8 bg-panel px-2.5 py-1.5 text-xs text-ink-dim outline-none"
        >
          <option value="">no project</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between">
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
              await deleteTask(task.id);
              router.push("/m/tasks");
              router.refresh();
            });
          }}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
            armedDelete
              ? "border border-flare/40 text-flare"
              : "text-ink-faint hover:text-flare",
          )}
        >
          <Trash2 className="size-3.5" />
          {armedDelete ? "click again to delete" : "delete"}
        </button>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-plasma">
              <Check className="size-3" /> saved
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded-lg bg-plasma/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
          >
            {pending ? "saving…" : "save"}
          </button>
        </div>
      </div>
    </div>
  );
}
