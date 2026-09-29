import { sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { tasks } from "../schema";

export async function OpenTasksWidget() {
  const [counts] = await db
    .select({
      todo: sql<number>`count(*) filter (where ${tasks.status} in ('backlog','todo'))`,
      doing: sql<number>`count(*) filter (where ${tasks.status} in ('doing','review'))`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done' and ${tasks.completedAt} > now() - interval '7 days')`,
    })
    .from(tasks);

  const open = Number(counts.todo) + Number(counts.doing);

  return (
    <div className="flex h-full flex-col justify-between gap-4">
      <p className="font-display text-5xl font-semibold tabular-nums text-ink text-glow">
        {open}
        <span className="ml-2 text-sm font-normal tracking-widest text-ink-dim">
          open
        </span>
      </p>
      <div className="flex gap-4 font-mono text-[11px] uppercase tracking-wider">
        <span className="text-ion">{Number(counts.todo)} queued</span>
        <span className="text-solar">{Number(counts.doing)} in flight</span>
        <span className="text-plasma">{Number(counts.done)} done this week</span>
      </div>
    </div>
  );
}
