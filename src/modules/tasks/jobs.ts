import type { ModuleJob } from "@/core/modules/types.server";
import { backfillWork } from "./core";

/**
 * Keeps identifiers complete: every project gets a key, every item a number.
 * Idempotent — a no-op once everything is numbered — so it runs on boot and
 * every 15 minutes to catch any writer that bypassed tasks/core.
 */
export const workJobs: ModuleJob[] = [
  {
    channel: "work_backfill",
    schedule: "*/15 * * * *",
    runOnBoot: true,
    handle: async (_payload, ctx) => {
      const r = await backfillWork(ctx.db);
      if (r.keys || r.numbers) console.log(`[work] backfill: ${r.keys} key(s), ${r.numbers} number(s)`);
    },
  },
];
