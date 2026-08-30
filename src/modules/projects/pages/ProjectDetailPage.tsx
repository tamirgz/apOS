import { lastActiveLabel } from "@/core/ui/time";
import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { GlassPanel } from "@/core/ui/GlassPanel";
import {
  completeProjectNextAction,
  listProjectCategories,
  listProjects,
  setProjectCategory,
  setProjectGoal,
  setProjectNextAction,
  setProjectRepo,
} from "../actions";
import { usableRepoPath } from "../repo";
import { AdvisorPanel } from "../components/AdvisorPanel";
import { getProjectCockpitById, getProjectTasks } from "../queries";
import { CockpitHeader } from "../components/CockpitHeader";
import { ProjectAttention } from "../components/ProjectAttention";
import { DeleteProjectButton } from "../components/DeleteProjectButton";
import { ProjectTaskQuickAdd } from "../components/ProjectTaskQuickAdd";
import { ProjectNotes } from "../components/ProjectNotes";
import { ProjectFiles } from "../components/ProjectFiles";
import { StatusCycleButton } from "../components/StatusCycleButton";
import { ProjectTitle } from "../components/ProjectTitle";
import { TaskBoard } from "../../tasks/components/TaskBoard";
import { listProjectFiles } from "../files-actions";
import { listProjectFeatures } from "../features-actions";
import { featureRefOf } from "../schema";
import { ProjectFeatures } from "../components/ProjectFeatures";

// shared: core/ui/time.ts lastActiveLabel

export async function ProjectDetailPage({ params }: ModuleRouteProps) {
  const [id] = params;
  const project = await getProjectCockpitById(id);

  if (!project) {
    return (
      <GlassPanel className="flex flex-col items-center gap-3 px-8 py-20 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          signal lost
        </p>
        <h2 className="font-display text-3xl font-semibold text-ink">
          No project answers at this id
        </h2>
        <Link
          href="/m/projects"
          className="mt-2 rounded-lg border border-plasma/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
        >
          back to projects
        </Link>
      </GlassPanel>
    );
  }

  const { listNotesForProject } = await import("@/modules/notes/actions");
  const { listAttentionForProject } = await import("@/modules/today/queries");
  const [projectTasks, projectNotes, attention, allProjects, projectFiles] =
    await Promise.all([
      getProjectTasks(id),
      listNotesForProject(id).catch(() => []),
      listAttentionForProject(id).catch(() => []),
      listProjects(),
      listProjectFiles(id),
    ]);
  const [categories, projectFeatures] = await Promise.all([
    listProjectCategories(),
    listProjectFeatures(id),
  ]);
  const projectOptions = allProjects.map((p) => ({ id: p.id, name: p.name }));
  const done = projectTasks.filter((t) => t.status === "done").length;
  const openAttention = attention.filter((a) => a.status === "open");

  // Split the project's tasks into feature groups + loose (standalone) tasks.
  const featureGroups = projectFeatures.map((feature) => ({
    feature,
    tasks: projectTasks.filter((t) => t.featureRef === featureRefOf(feature.id)),
  }));
  const looseTasks = projectTasks.filter((t) => !t.featureRef);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/m/projects"
          className="mb-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          projects
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <ProjectTitle id={project.id} name={project.name} />
          <StatusCycleButton id={project.id} status={project.status} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            {done}/{projectTasks.length} tasks
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href={`/m/ask?q=${encodeURIComponent(`Everything on ${project.name} — current status, open work, and risks`)}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ion/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/10"
              title="Cited answer over everything linked to this project"
            >
              <Sparkles className="size-3" />
              ask about this
            </Link>
            <DeleteProjectButton id={project.id} />
          </div>
        </div>
        {project.description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">
            {project.description}
          </p>
        )}
      </header>

      <CockpitHeader
        id={project.id}
        status={project.status}
        goal={project.goal}
        category={project.category}
        categories={categories}
        nextAction={project.nextAction}
        repoUrl={project.repoUrl}
        repoReady={!!usableRepoPath(project.id, project.repoUrl)}
        repoDigest={project.repoDigest}
        health={project.resolvedHealth.health}
        healthReason={project.resolvedHealth.reason}
        healthSource={project.resolvedHealth.source}
        stats={{
          open: project.taskCounts.open,
          done: project.taskCounts.done,
          overdue: project.taskCounts.overdue,
          notes: project.noteCount,
          attention: openAttention.length,
        }}
        lastActive={lastActiveLabel(project.lastActivityAt)}
        setGoal={setProjectGoal}
        setCategory={setProjectCategory}
        setNextAction={setProjectNextAction}
        setRepo={setProjectRepo}
        completeNextAction={completeProjectNextAction}
      />

      <AdvisorPanel
        projectId={project.id}
        state={project.advisorState}
        blocker={project.advisorBlocker}
        next={project.advisorNext}
        updatedAt={project.advisorUpdatedAt}
      />

      <ProjectAttention
        items={openAttention.map((a) => ({
          id: a.id,
          type: a.type,
          title: a.title,
          body: a.body,
        }))}
      />

      <ProjectFeatures
        projectId={project.id}
        groups={featureGroups}
        looseTasks={looseTasks.map((t) => ({ id: t.id, title: t.title }))}
      />

      <div className="flex items-center gap-2 px-1 pt-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
          tasks
        </span>
        <span className="font-mono text-xs tabular-nums text-ink-faint">{looseTasks.length}</span>
      </div>
      <ProjectTaskQuickAdd projectId={project.id} />

      <TaskBoard
        tasks={looseTasks}
        projectOptions={projectOptions}
        quickAddProjectRef={`projects:${project.id}`}
        hideQuickAdd
        hideProjectBadge
      />

      <ProjectNotes projectId={project.id} notes={projectNotes} />

      <ProjectFiles projectId={project.id} files={projectFiles} />
    </div>
  );
}
