import { sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { StatCell } from "@/core/ui/StatCell";
import { tasks } from "../schema";

/** Ambient strip: open task load + what's in flight. */
export async function TaskLoadStat() {
  const [c] = await db
    .select({
      todo: sql<number>`count(*) filter (where ${tasks.status} in ('backlog','todo'))`,
      doing: sql<number>`count(*) filter (where ${tasks.status} in ('doing','review'))`,
    })
    .from(tasks);
  const open = Number(c.todo) + Number(c.doing);
  return (
    <StatCell
      label="Work load"
      value={open}
      hint={`open · ${Number(c.doing)} in flight`}
      href="/m/tasks"
      accent="var(--color-ion)"
    />
  );
}
