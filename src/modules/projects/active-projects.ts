// The active_projects memory block, built from the tracker in code. A weekly
// LLM agent used to rewrite it: a week stale between runs, and it padded the
// facts with guessed "main thrust" / "pushing X" lines that every other AI call
// then repeated. Every fact here is a column or a count; nothing is inferred.
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/core/db/client";
import { memoryBlocks } from "@/core/db/schema/memory";
import type { ModuleJob } from "@/core/modules/types.server";
import { milestones } from "../tasks/schema";
import { getProjectCockpit } from "./queries";

export const ACTIVE_PROJECTS_BLOCK = "active_projects";
const DESCRIPTION =
  "Live summary of active projects and their state — built from the tracker, refreshed on every work change.";

const fmtDay = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** One line per active project: name — state — top open item. Paused ones get
 *  a single closing line, so an agent knows they exist but are parked. */
export async function buildActiveProjects(db: Db = defaultDb, budget = 1500): Promise<string> {
  const all = await getProjectCockpit(db);
  const active = all.filter((p) => p.status === "active" && p.kind !== "area");
  const paused = all.filter((p) => p.status === "paused" && p.kind !== "area");

  // Each project's next open milestone with a target date.
  const ms = active.length
    ? await db
        .select({ projectId: milestones.projectId, name: milestones.name, targetAt: milestones.targetAt })
        .from(milestones)
        .where(
          and(
            inArray(milestones.projectId, active.map((p) => p.id)),
            inArray(milestones.status, ["planned", "active"]),
            isNotNull(milestones.targetAt),
          ),
        )
        .orderBy(asc(milestones.targetAt))
    : [];
  const nextMilestone = new Map<string, (typeof ms)[number]>();
  for (const m of ms) if (!nextMilestone.has(m.projectId)) nextMilestone.set(m.projectId, m);

  const lines = active.map((p) => {
    const name = p.key ? `${p.name} (${p.key})` : p.name;
    const c = p.taskCounts;
    const state = [
      p.resolvedHealth.health,
      c.open ? `${c.open} open${c.overdue ? `, ${c.overdue} overdue` : ""}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    // A user-set next action or the top open task — never the advisor's guess.
    const top =
      p.nextActionSource === "task"
        ? `top: ${p.nextAction}`
        : p.nextActionSource === "user"
          ? `next: ${p.nextAction}`
          : "no open items";
    const m = nextMilestone.get(p.id);
    const due = m?.targetAt ? ` · milestone ${m.name} due ${fmtDay(m.targetAt)}` : "";
    return `${name} — ${state} — ${top}${due}`;
  });
  const tail = paused.length ? `Paused: ${paused.map((p) => p.name).join(", ")}.` : "";

  // Fit the block's budget: drop whole project lines from the end, and say so.
  const fit = (n: number) => {
    const more = active.length - n;
    return [...lines.slice(0, n), more ? `(+${more} more active)` : "", tail]
      .filter(Boolean)
      .join("\n");
  };
  let n = lines.length;
  while (n > 0 && fit(n).length > budget) n--;
  const out = fit(n);
  return (out.length > budget ? out.slice(0, budget) : out) || "No active projects.";
}

/** Rebuild the block; writes only on change. It's derived, so a replaced value
 *  isn't archived the way an agent- or user-written block's is. */
export async function refreshActiveProjects(db: Db = defaultDb): Promise<boolean> {
  const [block] = await db
    .select({ value: memoryBlocks.value, charLimit: memoryBlocks.charLimit, description: memoryBlocks.description })
    .from(memoryBlocks)
    .where(eq(memoryBlocks.label, ACTIVE_PROJECTS_BLOCK));
  if (!block) return false; // ensureDefaultMemoryBlocks creates it
  const next = await buildActiveProjects(db, block.charLimit);
  if (next === block.value && block.description === DESCRIPTION) return false;
  await db
    .update(memoryBlocks)
    .set({ value: next, description: DESCRIPTION, updatedAt: new Date() })
    .where(eq(memoryBlocks.label, ACTIVE_PROJECTS_BLOCK));
  return true;
}

// Every tracker write NOTIFYs work_changed (a bulk import sends a burst), so
// changes within DEBOUNCE_MS share one rebuild.
const DEBOUNCE_MS = 30_000;
let waiting: Promise<void> | null = null;

export const activeProjectsJobs: ModuleJob[] = [
  {
    channel: "work_changed",
    runOnBoot: true,
    handle: async (payload, ctx) => {
      const run = async () => {
        if (await refreshActiveProjects(ctx.db)) console.log("[projects] active_projects rebuilt");
      };
      if (!payload) return run(); // boot: no burst to wait for
      if (waiting) return waiting;
      waiting = new Promise<void>((r) => setTimeout(r, DEBOUNCE_MS)).then(() => {
        waiting = null;
        return run();
      });
      return waiting;
    },
  },
];
