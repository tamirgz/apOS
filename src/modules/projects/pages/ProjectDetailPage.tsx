import { lastActiveLabel } from "@/core/ui/time";
import Link from "next/link";
import { Download, GitBranch } from "lucide-react";
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
import { ProjectPlan, ProjectVitals } from "../components/CockpitHeader";
import { ProjectPulse } from "../components/ProjectPulse";
import { pulseProps } from "../pulse";
import { HEALTH_META } from "../health";
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

  const imported = work.items.some((t) => t.externalRef?.startsWith("plane:"));
  const openCount = work.items.length - done;
  const chipTone = (c: string) => ({ color: c, borderColor: `color-mix(in oklab, ${c} 35%, transparent)` });

  return (
    <div className="flex flex-col gap-6">
      <WorkView
        data={work}
        projectId={project.id}
        head={{
          crumb: (
            <>
              <Link href="/m/tasks" className="transition hover:text-ink">
                Work
              </Link>{" "}
              /{" "}
              <Link href="/m/projects" className="transition hover:text-ink">
                Projects
              </Link>{" "}
              / {project.key ?? project.name}
            </>
          ),
          title: <ProjectTitle id={project.id} name={project.name} size="head" />,
          chips: (
            <>
              <Link href="?tab=overview" className="wk-chip transition hover:brightness-125" style={chipTone(HEALTH_META[project.resolvedHealth.health].accent)} title={project.resolvedHealth.reason}>
                <span className="dot" />
                {HEALTH_META[project.resolvedHealth.health].label}
              </Link>
              <StatusCycleButton id={project.id} status={project.status} />
              {project.key && project.key !== project.name && (
                <span className="wk-chip font-mono" title="Work-item key — items are numbered KEY-N">
                  {project.key}
                </span>
              )}
              <span className="wk-chip">
                <span className="font-mono tabular-nums text-ink">{openCount}</span> open · {done} done
              </span>
              {project.repoUrl && (
                <span className="wk-chip" title={project.repoUrl}>
                  <GitBranch className="size-3" /> {project.repoUrl.includes("github.com") ? "github" : "repo"} · linked
                </span>
              )}
              {imported && (
                <span className="wk-chip" title="Items were imported from a Plane workspace">
                  <Download className="size-3" /> Plane · imported
                </span>
              )}
              {openAttention.length > 0 && (
                <Link href="?tab=overview" className="wk-chip" style={chipTone("var(--color-solar)")}>
                  <span className="dot" />
                  {openAttention.length} needs you
                </Link>
              )}
            </>
          ),
          actions: <DeleteProjectButton id={project.id} />,
          askLabel: "Ask about this project",
          askQuery: `Everything on ${project.name} — current status, open work, and risks`,
          about: project.description ? <p className="max-w-3xl text-sm leading-relaxed text-ink-dim">{project.description}</p> : undefined,
        }}
        overview={
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
            <div className="flex min-w-0 flex-col gap-5">
              <ProjectPlan
                id={project.id}
                goal={project.goal}
                nextAction={project.nextAction}
                repoUrl={project.repoUrl}
                repoReady={!!usableRepoPath(project.id, project.repoUrl)}
                repoDigest={project.repoDigest}
                setGoal={setProjectGoal}
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
            </div>
            <aside className="flex min-w-0 flex-col gap-5">
              <ProjectVitals
                id={project.id}
                status={project.status}
                category={project.category}
                categories={categories}
                health={project.resolvedHealth.health}
                healthReason={project.resolvedHealth.reason}
                healthSource={project.resolvedHealth.source}
                stats={{
                  open: project.taskCounts.open,
                  done: project.taskCounts.done,
                  overdue: project.taskCounts.overdue,
                  notes: project.noteCount,
                }}
                lastActive={lastActiveLabel(project.lastActivityAt)}
                setCategory={setProjectCategory}
              />
              <ProjectPulse {...pulseProps(work)} />
            </aside>
            <div className="grid min-w-0 items-start gap-5 md:grid-cols-2 xl:col-span-2">
              <ProjectNotes projectId={project.id} notes={projectNotes} />
              <ProjectFiles projectId={project.id} files={projectFiles} />
            </div>
          </div>
        }
      />
    </div>
  );
}
