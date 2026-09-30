import { isNotNull } from "drizzle-orm";
import { db } from "@/core/db/client";
import { projects } from "@/modules/projects/schema";
import { usableRepoPath } from "@/modules/projects/repo";
import { listChannels } from "@/modules/telegram/queries";
import { listExecutors, listRoutines, listTasks } from "../queries";
import { listFreeModelsByExecutor } from "../models";
import { NewTaskBox } from "../components/NewTaskBox";
import { TaskBoard } from "../components/TaskBoard";
import { ArchivedTasks } from "../components/ArchivedTasks";
import { RoutinesPanel } from "../components/RoutinesPanel";
import { SectionTabs } from "@/core/ui/SectionTabs";

export async function WorkbenchPage() {
  const [tasks, archived, executors, routines, tgChannels] = await Promise.all([
    listTasks(),
    listTasks(true),
    listExecutors(),
    listRoutines(),
    listChannels(),
  ]);
  // Free models per executor — opencode gets its cloud free tier too.
  const freeModels = await listFreeModelsByExecutor(executors.map((x) => x.id));

  // Projects with an attached, cloned repo — pickable as the repo for a code
  // task so the agent reads that project's real code (feature #9).
  const projectRepoRows = await db
    .select({ id: projects.id, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(isNotNull(projects.repoUrl));
  const projectRepos = projectRepoRows
    .map((p) => ({
      name: p.name,
      path: usableRepoPath(p.id, p.repoUrl),
      source: p.repoUrl,
    }))
    .filter((r): r is { name: string; path: string; source: string | null } =>
      Boolean(r.path),
    );

  return (
    <div>
      <SectionTabs section="automation" />
      {/* The repo you work in most is the sane default for code tasks. */}
      <NewTaskBox
        defaultRepo={process.cwd()}
        executors={executors}
        freeModels={freeModels}
        projectRepos={projectRepos}
      />
      <TaskBoard tasks={tasks} />
      <RoutinesPanel
        routines={routines}
        projects={projectRepoRows.map((p) => ({ id: p.id, name: p.name }))}
        executors={executors.map((x) => ({ id: x.id, name: x.name }))}
        freeModels={freeModels}
        sources={tgChannels.map((c) => ({ ref: `telegram:${c.username}`, label: `Telegram · @${c.username}` }))}
      />
      <ArchivedTasks tasks={archived} />
    </div>
  );
}
