import { eq, isNotNull } from "drizzle-orm";
import type { ModuleJob } from "@/core/modules/types.server";
import { db, sql } from "@/core/db/client";
import { projects } from "./schema";
import { projectRepoDir, syncProjectRepo } from "./repo";

const log = (m: string) => console.log(`[projects] ${m}`);

/** Refresh one project's copy and record the outcome for the cockpit. */
export async function refreshProjectRepo(id: string): Promise<void> {
  const [p] = await db
    .select({ id: projects.id, repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.id, id));
  if (!p?.repoUrl) return;
  const r = await syncProjectRepo(p.id, p.repoUrl);
  log(`repo ${p.id.slice(0, 8)} — ${r.ok ? r.detail : `FAILED: ${r.detail}`}`);
  await db
    .update(projects)
    .set(r.ok ? { repoSyncedAt: new Date(), repoSyncError: null } : { repoSyncError: r.detail })
    .where(eq(projects.id, p.id));
  // Nudge the cockpit so the "cloning…" chip flips to "synced" without a reload.
  await sql.notify("projects_changed", p.id);
}

/**
 * Refresh the copy behind a Workbench repo path just before a run, so a
 * delegated task never starts from code up to a day old. No-op for a path
 * that isn't one of the project copies.
 */
export async function refreshRepoAt(repoPath: string): Promise<void> {
  const id = repoPath.split("/").pop() ?? "";
  if (/^[0-9a-f-]{36}$/i.test(id) && projectRepoDir(id) === repoPath) await refreshProjectRepo(id);
}

/** Clone/refresh project repos. NOTIFY payload = one projectId; empty = all. */
export const projectRepoJobs: ModuleJob[] = [
  {
    channel: "project_repos_sync",
    // Nightly, in the quiet hour beside memory maintenance (03:30) and before
    // the morning advisor/repo-watcher reads. Attaching a repo syncs it at
    // once (NOTIFY), and a Workbench run refreshes its own copy first.
    schedule: "15 3 * * *",
    handle: async (payload) => {
      const id = payload?.trim();
      if (id && /^[0-9a-f-]{36}$/i.test(id)) return refreshProjectRepo(id);
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(isNotNull(projects.repoUrl));
      for (const p of rows) await refreshProjectRepo(p.id);
    },
  },
];
