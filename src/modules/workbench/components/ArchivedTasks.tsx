"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, GitBranch, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { deleteTask, unarchiveTask } from "../actions";
import type { TaskWithAttempt } from "../queries";

/**
 * Archived tasks are hidden, not gone — this is where they live, and the only
 * place anything can actually be deleted. Delete is two-step rather than a
 * browser confirm: it stays inside the app's own language, and a mis-click
 * costs one extra click instead of a task.
 */
export function ArchivedTasks({ tasks }: { tasks: TaskWithAttempt[] }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (tasks.length === 0) return null;

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint transition hover:text-ink-dim"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        archived · {tasks.length}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2.5 flex flex-col gap-1.5">
              {tasks.map((t) => (
                <div
                  key={t.id}
                  className="glass flex items-center gap-3 rounded-xl px-3 py-2"
                >
                  <Link
                    href={`/m/workbench/${t.id}`}
                    className="min-w-0 flex-1 truncate text-sm text-ink-dim transition hover:text-ink"
                  >
                    {t.title}
                  </Link>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                    {t.taskType} · {t.attemptCount} attempt
                    {t.attemptCount === 1 ? "" : "s"}
                  </span>
                  {t.latest?.branch && (
                    <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-ion/60">
                      <GitBranch className="size-2.5" />
                      {t.latest.branch.replace("aios/", "")}
                    </span>
                  )}

                  <button
                    type="button"
                    disabled={pending}
                    title="Put back on the board"
                    onClick={() =>
                      start(async () => {
                        await act(() => unarchiveTask(t.id), { failed: "Couldn't restore the task" });
                      })
                    }
                    className="shrink-0 rounded-md p-1.5 text-ink-faint transition hover:text-ion disabled:opacity-40"
                  >
                    <RotateCcw className="size-3" />
                  </button>

                  {confirming === t.id ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const res = await act(() => deleteTask(t.id), { failed: "Couldn't delete the task" });
                          setConfirming(null);
                          if (!res.ok) return;
                          const r = res.value;
                          setNote(
                            r.keptBranches.length
                              ? `deleted · kept unmerged ${r.keptBranches.join(", ")}`
                              : r.deletedBranches.length
                                ? `deleted · removed ${r.deletedBranches.join(", ")}`
                                : "deleted",
                          );
                        })
                      }
                      className="shrink-0 rounded-md border border-flare/40 bg-flare/15 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-flare transition hover:bg-flare/25 disabled:opacity-40"
                    >
                      delete for good?
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      title="Delete permanently"
                      onClick={() => setConfirming(t.id)}
                      className="shrink-0 rounded-md p-1.5 text-ink-faint transition hover:text-flare disabled:opacity-40"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {note && (
              <p className="mt-2 px-1 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                {note}
              </p>
            )}
            <p className="mt-2 px-1 text-xs text-ink-faint">
              Deleting removes the task, its attempts and its event log.
              Worktrees go too — but a branch that isn&apos;t merged yet is kept,
              because it holds work you haven&apos;t taken.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
