"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Flame, Trash2, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { deleteTask, updateTask } from "../actions";
import type { Task, TaskPriority } from "../schema";

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: "text-flare",
  medium: "text-solar",
  low: "text-ink-faint",
};

/** Local-date input value — toISOString() shifted the day across UTC. */
function toDateInput(d: Date | string | null): string {
  if (!d) return "";
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/**
 * Full edit surface for a task: title, notes, priority, due date, and which
 * project it's linked to (or none). Opened by clicking a task card's title.
 */
export function TaskEditModal({
  task,
  projectOptions,
  onClose,
}: {
  task: Task;
  projectOptions: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueAt, setDueAt] = useState(toDateInput(task.dueAt));
  const [projectId, setProjectId] = useState(task.projectRef?.split(":")[1] ?? "");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // Notes grow to fit their content (capped, then scroll) — no more cramming a
  // long note into three fixed rows. The user can still drag it taller.
  const autoGrow = () => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(autoGrow, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      router.refresh();
      onClose();
    });
  };

  const remove = () => {
    start(async () => {
      await deleteTask(task.id);
      router.refresh();
      onClose();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-void/60 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
        onClick={(e) => e.stopPropagation()}
        className="glass max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            edit task
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-faint transition hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          placeholder="Title"
          autoFocus
          className="mb-2 w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
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
          rows={3}
          placeholder="Notes…"
          className="mb-3 max-h-[45vh] min-h-[4.5rem] w-full resize-y overflow-y-auto rounded-lg bg-white/5 px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
        />

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setPriority((p) =>
                p === "medium" ? "high" : p === "high" ? "low" : "medium",
              )
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
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            title="Delete task"
            className="rounded-md p-1.5 text-ink-faint transition hover:bg-flare/10 hover:text-flare disabled:opacity-40"
          >
            <Trash2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded-lg bg-plasma/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
          >
            {pending ? "saving…" : "save"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
