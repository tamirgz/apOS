import type { ModuleJob } from "@/core/modules/types.server";
import { sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { notes } from "../notes/schema";
import { tasks } from "../tasks/schema";
import { getProjectCockpit } from "./queries";
import { projects } from "./schema";

const IDLE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

/**
 * "Set up or archive" — the ONE card an empty project gets, instead of the
 * daily generic coaching the pulse/advisor used to manufacture when a project
 * had nothing tracked. A project qualifies when it is active, a real project
 * (not an area), has no open work items, no attached repo (the repo watcher
 * is its own signal), and nothing has moved for IDLE_DAYS.
 *
 * Idempotent by construction: the key `setup:<projectId>` may produce one card
 * EVER (oncePerKey), so dismissing it is a permanent "I know", and the weekly
 * run is a no-op for every project that already had one.
 */
export async function raiseSetupCards(): Promise<number> {
  const { insertAttentionItem } = await import("@/modules/today/core");
  const rows = await getProjectCockpit(db);
  let raised = 0;
  for (const p of rows) {
    if (p.status !== "active" || p.kind === "area" || p.repoUrl) continue;
    if (p.taskCounts.open > 0) continue;
    // Idle is measured on HUMAN signals only. The cockpit's lastActivityAt also
    // counts attention cards, so the agents' own coaching cards would keep an
    // untouched project looking busy forever.
    const [row] = (await db.execute(sql`
      select greatest(
        ${projects.updatedAt},
        (select max(coalesce(${tasks.completedAt}, ${tasks.createdAt})) from ${tasks} where ${tasks.projectRef} = ${`projects:${p.id}`}),
        (select max(${notes.updatedAt}) from ${notes} where ${notes.projectRefs} @> ${JSON.stringify([`projects:${p.id}`])}::jsonb)
      ) as last
      from ${projects} where ${projects.id} = ${p.id}
    `)) as unknown as { last: string | null }[];
    const last = row?.last ? new Date(row.last) : null;
    const idle = last ? Math.floor((Date.now() - +last) / DAY) : null;
    if (idle !== null && idle < IDLE_DAYS) continue;
    const before = Date.now();
    const card = await insertAttentionItem({
      type: "question",
      title: `Set up or archive ${p.name}?`,
      body: `${p.name} has no open work items and no attached repo${idle !== null ? `, and nothing has moved in ${idle} days` : ""}. Add the next few work items, attach its repo, or archive it so the agents stop reviewing it.`,
      projectRef: `projects:${p.id}`,
      href: `/m/projects/${p.id}`,
      source: "system:project-setup",
      urgency: 5,
      fixedDedupeKey: `setup:${p.id}`,
      oncePerKey: true,
    });
    if (+card.createdAt >= before - 1000) raised++;
  }
  return raised;
}

export const projectSetupJobs: ModuleJob[] = [
  {
    channel: "project_setup_cards",
    schedule: "20 7 * * 1", // Monday 07:20 — after the pulse, once a week
    handle: async () => {
      const n = await raiseSetupCards();
      console.log(`[projects] setup cards: raised ${n}`);
    },
  },
];
