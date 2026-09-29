import type { ModuleJob } from "@/core/modules/types.server";
import { backfillWork } from "./core";
import { linkCommits } from "./commits";
import { syncFromWorkbench, syncPendingWorkbenchLinks } from "./delegate";

export const workJobs: ModuleJob[] = [
  {
    // Identifiers stay complete (every project a key, every item a number) and
    // Workbench outcomes missed while the worker was down get written back.
    // Idempotent — a no-op when nothing is missing.
    channel: "work_backfill",
    schedule: "*/15 * * * *",
    runOnBoot: true,
    handle: async (_payload, ctx) => {
      const r = await backfillWork(ctx.db);
      const wb = await syncPendingWorkbenchLinks(ctx.db);
      if (r.keys || r.numbers || wb) {
        console.log(`[work] backfill: ${r.keys} key(s), ${r.numbers} number(s), ${wb} workbench write-back(s)`);
      }
    },
  },
  {
    // Commits mentioning KEY-N → links; "fixes KEY-N" → done. Reads the cache
    // clones project_repos_sync keeps fresh; per-repo ledger, so cheap.
    channel: "work_commit_links",
    schedule: "*/10 * * * *",
    runOnBoot: true,
    handle: async (_payload, ctx) => {
      const r = await linkCommits(ctx.db);
      if (r.linked || r.closed) console.log(`[work] commits: ${r.linked} link(s), ${r.closed} closed across ${r.repos} repo(s)`);
    },
  },
  {
    // A delegated item's Workbench run changed state → write it back.
    channel: "workbench_changed",
    handle: async (payload, ctx) => {
      if (!/^[0-9a-f-]{36}$/.test(payload)) return;
      const n = await syncFromWorkbench(ctx.db, payload);
      if (n) console.log(`[work] workbench ${payload.slice(0, 8)} → ${n} item(s) updated`);
    },
  },
  {
    channel: "plane_import",
    handle: async (payload, ctx) => {
      const { runPlaneJob } = await import("./plane/import");
      const { planeConfig, httpTransport } = await import("./plane/client");
      const cfg = await planeConfig();
      await runPlaneJob(ctx.db, payload, cfg ? httpTransport(cfg, (m) => console.log(`[plane] ${m}`)) : null);
    },
  },
];
