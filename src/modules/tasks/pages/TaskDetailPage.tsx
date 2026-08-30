import { eq } from "drizzle-orm";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { db } from "@/core/db/client";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { listProjectOptions } from "@/modules/projects/queries";
import { tasks } from "../schema";
import { TaskDetailCard } from "../components/TaskDetailCard";

/**
 * /m/tasks/<id> — the landing page for every task-shaped link in the system
 * (planner cards, triage results, search hits, widgets). Before this route
 * they all dumped on the full board and you hunted.
 */
export async function TaskDetailPage({ params }: ModuleRouteProps) {
  const [id] = params;
  const task =
    id && /^[0-9a-f-]{36}$/i.test(id)
      ? (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
      : undefined;

  if (!task) {
    return (
      <div className="glass flex flex-col items-center gap-3 rounded-2xl px-8 py-16 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          task not found
        </p>
        <p className="text-sm text-ink-dim">It may have been deleted.</p>
        <Link
          href="/m/tasks"
          className="mt-1 rounded-lg border border-plasma/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
        >
          back to tasks
        </Link>
      </div>
    );
  }

  const projectOptions = await listProjectOptions();

  return (
    <div className="max-w-2xl">
      <Link
        href="/m/tasks"
        className="mb-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        tasks
      </Link>
      <TaskDetailCard task={task} projectOptions={projectOptions} />
    </div>
  );
}
