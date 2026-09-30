import type { WorkData } from "@/modules/tasks/queries";
import { moduleStats } from "@/modules/tasks/stats";

/** What the Overview's pulse card needs from the work data: the running cycle, its items, and the live modules nearest their target. */
export function pulseProps(work: WorkData) {
  const cycle = work.cycles.find((c) => c.status === "current") ?? null;
  const stats = moduleStats(work.items);
  const modules = work.features
    .filter((f) => f.status === "active" || f.status === "planned" || f.status === "paused")
    .filter((f) => (stats.get(f.id)?.total ?? 0) > 0 || f.targetAt)
    .sort(
      (a, b) =>
        (a.targetAt ? +new Date(a.targetAt) : Infinity) - (b.targetAt ? +new Date(b.targetAt) : Infinity) ||
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
        a.sortOrder - b.sortOrder,
    )
    .slice(0, 4)
    .map((f) => ({ f, s: stats.get(f.id) }));
  return {
    cycle,
    cycleItems: cycle ? work.items.filter((t) => t.cycleId === cycle.id) : [],
    blocked: work.blocked,
    modules,
  };
}
