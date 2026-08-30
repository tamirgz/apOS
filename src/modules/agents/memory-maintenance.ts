import type { ModuleJob } from "@/core/modules/types.server";
import {
  checkMemoryFreshness,
  compactMemoryEntries,
  pruneMemoryEntries,
} from "@/core/memory";

/**
 * Daily maintenance for the memory system:
 *  1. prune the archival tier so the long-tail can't grow without bound;
 *  2. check block FRESHNESS — the always-injected snapshot is bounded, which is
 *     only safe if it keeps being refreshed, so a stale consolidation is
 *     surfaced as a card. Together with MAX_INJECTED_CHARS this makes bounded
 *     injection an improvement, not a way to silently forget.
 * Deterministic and cheap; no LLM.
 */
export const memoryMaintenanceJobs: ModuleJob[] = [
  {
    channel: "memory_maintenance",
    schedule: "30 3 * * *", // 03:30 daily, a quiet hour
    handle: async () => {
      await pruneMemoryEntries();
      await compactMemoryEntries();
      const stale = await checkMemoryFreshness();
      if (stale.length) {
        // System-health FYI about the memory subsystem itself — belongs in the
        // bell feed (warn), not "Needs You". `warn` + Slack delivery surfaces it
        // more reliably than a low-urgency card buried under real to-dos.
        const { notify } = await import("@/core/notify");
        await notify({
          title: "Working memory is going stale",
          body:
            `These always-injected memory blocks haven't been refreshed in a while: ` +
            `${stale.map((s) => `${s.label} (${s.ageDays}d)`).join(", ")}. ` +
            `The weekly Memory-consolidation agent may have stopped — check the Agents page.`,
          level: "warn",
          source: "memory",
          href: "/m/agents",
        });
      }
    },
  },
];
