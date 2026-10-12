/**
 * Unit tests for cycle / module progress math (src/modules/tasks/stats.ts).
 * Pure — no DB. Run: npx tsx scripts/test-stats.mts  (exit non-zero on failure)
 *
 * The rule under test: progress counts by points only when EVERY in-scope item
 * is estimated; otherwise by items. A mixed cycle (ETHOS-Sec "Week of Oct 11":
 * 35 items, 20 done, one 3-pt todo) used to read "0% of 3 pts" and its status
 * bar dropped the 34 unestimated items.
 */
import * as stats from "@/modules/tasks/stats";
import type { CycleSummary } from "@/modules/tasks/cycles";
import type { WorkItem } from "@/modules/tasks/core";

const { cycleMetrics, moduleStats, modulePct } = stats;
// Namespace read so the suite also runs (red) against code without moduleUnit.
const moduleUnit: typeof stats.moduleUnit = (stats as Partial<typeof stats>).moduleUnit ?? (() => undefined as never);

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

const NOW = Date.parse("2026-10-12T12:00:00Z");
const cycle = { id: "c1", endsAt: "2026-10-17T00:00:00Z", burndown: [] } as unknown as CycleSummary;
let n = 0;
const item = (status: WorkItem["status"], estimate: number | null): WorkItem =>
  ({ id: `t${++n}`, status, estimate, cycleId: "c1", featureRef: "features:f1", dueAt: null, completedAt: null }) as unknown as WorkItem;
const many = (k: number, status: WorkItem["status"], estimate: number | null) => Array.from({ length: k }, () => item(status, estimate));

// ── mixed: the reported case ────────────────────────────────────────────────
{
  const items = [...many(20, "done", null), ...many(14, "todo", null), item("todo", 3)];
  const m = cycleMetrics(cycle, items, [], NOW);
  eq("mixed cycle → counts by items", m.unit, "items");
  eq("mixed cycle → 57% (20 of 35)", [m.pct, m.total], [57, 35]);
  const bar = m.items ?? m.by; // the counts the status bar shows (pre-fix code had only `by`)
  eq("mixed cycle → no item dropped from the status counts", bar.done + bar.review + bar.doing + bar.todo, 35);
  eq("mixed cycle → says how many have no estimate", m.unestimated, 34);
  const s = moduleStats(items).get("f1");
  eq("mixed module → counts by items", moduleUnit(s), "items");
  eq("mixed module → 57%", modulePct(s), 57);
  eq("mixed module → unestimated count", s ? s.total - s.estimated : null, 34);
}

// ── all estimated ──────────────────────────────────────────────────────────
{
  const items = [item("done", 5), item("done", 3), item("doing", 2), item("todo", 10)];
  const m = cycleMetrics(cycle, items, [], NOW);
  eq("all-estimated cycle → counts by points", m.unit, "pts");
  eq("all-estimated cycle → 40% of 20 pts", [m.pct, m.total], [40, 20]);
  eq("all-estimated cycle → item counts intact", m.items, { done: 2, review: 0, doing: 1, todo: 1 });
  eq("all-estimated cycle → 0 unestimated", m.unestimated, 0);
  const s = moduleStats(items).get("f1");
  eq("all-estimated module → points", [moduleUnit(s), modulePct(s)], ["pts", 40]);
}

// ── none estimated ─────────────────────────────────────────────────────────
{
  const items = [item("done", null), item("review", null), item("todo", null), item("backlog", null)];
  const m = cycleMetrics(cycle, items, [], NOW);
  eq("unestimated cycle → items, 25%", [m.unit, m.pct, m.total], ["items", 25, 4]);
  eq("unestimated cycle → 4 unestimated", m.unestimated, 4);
  const s = moduleStats(items).get("f1");
  eq("unestimated module → items, 25%", [moduleUnit(s), modulePct(s)], ["items", 25]);
}

// ── all estimated as 0 pts: points carry no signal, count items ────────────
{
  const items = [item("done", 0), item("todo", 0)];
  const m = cycleMetrics(cycle, items, [], NOW);
  eq("zero-point cycle → items, 50%", [m.unit, m.pct], ["items", 50]);
}

// ── cancelled items are out of scope (an unestimated cancelled item doesn't flip the unit)
{
  const items = [item("done", 2), item("todo", 2), item("cancelled", null)];
  const m = cycleMetrics(cycle, items, [], NOW);
  eq("cancelled ignored → points, 50%", [m.unit, m.pct], ["pts", 50]);
  eq("cancelled ignored → module points", moduleUnit(moduleStats(items).get("f1")), "pts");
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
