import type { ModuleJob } from "@/core/modules/types.server";
import { db } from "@/core/db/client";
import { getProjectCockpit } from "./queries";

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
    const idle = p.lastActivityAt ? Math.floor((Date.now() - +p.lastActivityAt) / DAY) : null;
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
