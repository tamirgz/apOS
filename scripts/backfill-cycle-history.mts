/**
 * Rebuild each cycle's membership from before the cycle_membership trigger
 * (task_activity), and mark the cycles whose plan the history can't settle.
 * Dry run by default; --apply writes. Idempotent.
 *
 *   pnpm tsx --env-file=.env.local scripts/backfill-cycle-history.mts [--project <key|name>] [--apply]
 */
import { eq, or } from "drizzle-orm";
import { db } from "../src/core/db/client";
import { projects } from "../src/modules/projects/schema";
import { backfillCycleHistory } from "../src/modules/tasks/cycle-history";
import { listCycles } from "../src/modules/tasks/cycles";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const want = args[args.indexOf("--project") + 1];
let projectId: string | undefined;
if (args.includes("--project")) {
  const [p] = await db.select({ id: projects.id }).from(projects).where(or(eq(projects.key, want), eq(projects.name, want)));
  if (!p) throw new Error(`No project ${want}`);
  projectId = p.id;
}

const r = await backfillCycleHistory(db, { apply, projectId });
console.log(`${apply ? "applied" : "dry run"} — history before ${r.since.toISOString()}, ${r.stays} stays rebuilt`);
const plans = apply ? new Map((await listCycles(db, { projectId })).map((c) => [c.id, c.plan])) : new Map();
for (const c of [...r.cycles].sort((a, b) => a.lock.getTime() - b.lock.getTime())) {
  const p = plans.get(c.id);
  const fig = !c.complete
    ? "plan history incomplete"
    : p
      ? `${p.plannedDone} of ${p.planned} planned done${p.ratio === null ? "" : ` (${Math.round(p.ratio * 100)}%)`}, +${p.added} added (${p.addedDone} done), ${p.plannedCancelled} cancelled, ${p.carriedOver} carried over`
      : "complete";
  console.log(`${c.name.padEnd(28)} lock ${c.lock.toISOString().slice(0, 10)}  ${fig}${c.reasons ? `  [${c.reasons} item(s) with gaps]` : ""}`);
}
process.exit(0);
