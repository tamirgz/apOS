import { lastActiveLabel } from "@/core/ui/time";
import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { GlassPanel } from "@/core/ui/GlassPanel";
import {
  completeProjectNextAction,
  listProjectCategories,
  setProjectCategory,
  setProjectGoal,
  setProjectNextAction,
  setProjectRepo,
} from "../actions";
import { usableRepoPath } from "../repo";
import { AdvisorPanel } from "../components/AdvisorPanel";
import { getProjectCockpitById } from "../queries";
import { CockpitHeader } from "../components/CockpitHeader";
import { ProjectAttention } from "../components/ProjectAttention";
import { DeleteProjectButton } from "../components/DeleteProjectButton";
import { ProjectNotes } from "../components/ProjectNotes";
import { ProjectFiles } from "../components/ProjectFiles";
import { StatusCycleButton } from "../components/StatusCycleButton";
import { ProjectTitle } from "../components/ProjectTitle";
import { WorkView } from "../../tasks/components/WorkView";
import { loadWorkData } from "../../tasks/queries";
import { listProjectFiles } from "../files-actions";

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
  const [work, projectNotes, attention, projectFiles, categories] = await Promise.all([
    loadWorkData(id),
    listNotesForProject(id).catch(() => []),
    listAttentionForProject(id).catch(() => []),
    listProjectFiles(id),
    listProjectCategories(),
  ]);
  const done = work.items.filter((t) => t.status === "done" || t.status === "cancelled").length;
  const openAttention = attention.filter((a) => a.status === "open");

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
          {project.key && (
            <span className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-ink-dim" title="Work-item key — items are numbered KEY-N">
              {project.key}
            </span>
          )}
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            {done}/{work.items.length} items
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

      <WorkView data={work} projectId={project.id} />

      <ProjectNotes projectId={project.id} notes={projectNotes} />

      <ProjectFiles projectId={project.id} files={projectFiles} />
    </div>
  );
}
