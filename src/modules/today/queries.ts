import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/core/db/client";
import { approvals } from "@/core/db/schema/approvals";
import { projects } from "@/modules/projects/schema";
import { getAgenda, type AgendaItem } from "@/modules/calendar/agenda";
import { attentionItems, type AttentionType } from "./schema";

/**
 * A row in the "Needs you" queue. The queue is a UNION of three existing
 * sources normalized to one shape (ONE-STOP §3.6 — aggregate, don't
 * duplicate): the attention_items atom, the pending approval queue, and the
 * Workbench's needs_input tasks. Everything the user must attend to, once.
 */
export interface NeedsYouItem {
  id: string;
  kind: "attention" | "approval" | "workbench";
  type: AttentionType; // notify | question | review | approve | do
  title: string;
  body: string | null;
  source: string;
  urgency: number;
  href: string | null;
  createdAt: Date;
  /** Only for kind === "attention" — enables done/dismiss/snooze inline. */
  attentionType?: AttentionType;
  payload?: Record<string, unknown>;
  /** One-click traversal: the card's grounded anchors, resolved to names. */
  project?: { id: string; name: string } | null;
  person?: { id: string; name: string } | null;
}

/** Higher first, then newest. Approvals and needs_input outrank FYIs. */
function sortQueue(items: NeedsYouItem[]): NeedsYouItem[] {
  return items.sort(
    (a, b) =>
      b.urgency - a.urgency || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

export async function listNeedsYou(): Promise<NeedsYouItem[]> {
  const [items, pendingApprovals, wbTasks] = await Promise.all([
    db
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.status, "open"))
      .orderBy(desc(attentionItems.urgency))
      .limit(100),
    db
      .select()
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .orderBy(desc(approvals.createdAt))
      .limit(50),
    // Workbench tasks waiting on the user. Imported lazily to keep the module
    // graph acyclic and avoid pulling the engine into the web bundle.
    (async () => {
      const { workbenchTasks } = await import("@/modules/workbench/schema");
      return db
        .select({
          id: workbenchTasks.id,
          title: workbenchTasks.title,
          status: workbenchTasks.status,
          summary: workbenchTasks.summary,
          updatedAt: workbenchTasks.updatedAt,
        })
        .from(workbenchTasks)
        .where(inArray(workbenchTasks.status, ["needs_input", "review"]))
        .orderBy(desc(workbenchTasks.updatedAt))
        .limit(30);
    })(),
  ]);

  // Resolve the cards' project/person anchors to names, so each card renders
  // clickable chips (insertAttentionItem grounds these refs; they were being
  // dropped on the floor here).
  const refId = (ref: string | null) => ref?.split(":")[1] ?? null;
  const projectIds = [...new Set(items.map((a) => refId(a.projectRef)).filter((x): x is string => !!x))];
  const personIds = [...new Set(items.map((a) => refId(a.personRef)).filter((x): x is string => !!x))];
  const [projectRows, personRows] = await Promise.all([
    projectIds.length
      ? db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
      : Promise.resolve([]),
    (async () => {
      if (!personIds.length) return [];
      const { people } = await import("@/modules/people/schema");
      return db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds));
    })(),
  ]);
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const personName = new Map(personRows.map((p) => [p.id, p.name]));

  const rows: NeedsYouItem[] = [
    ...items.map((a) => {
      const pid = refId(a.projectRef);
      const hid = refId(a.personRef);
      return {
        id: a.id,
        kind: "attention" as const,
        type: a.type,
        title: a.title,
        body: a.body,
        source: a.source,
        // FYIs sit below anything actionable unless explicitly urgent.
        urgency: a.urgency + (a.type === "notify" ? 0 : 10),
        href: a.href,
        createdAt: a.createdAt,
        attentionType: a.type,
        payload: (a.payload ?? {}) as Record<string, unknown>,
        project: pid && projectName.has(pid) ? { id: pid, name: projectName.get(pid)! } : null,
        person: hid && personName.has(hid) ? { id: hid, name: personName.get(hid)! } : null,
      };
    }),
    ...pendingApprovals.map((p) => ({
      id: p.id,
      kind: "approval" as const,
      type: "approve" as const,
      title: `${p.agentName} wants to ${p.toolName}`,
      body: JSON.stringify(p.input).slice(0, 200),
      source: `agent:${p.agentName}`,
      urgency: 30, // approvals block an agent — surface high
      href: "/m/agents",
      createdAt: p.createdAt,
    })),
    ...wbTasks.map((w) => ({
      id: w.id,
      kind: "workbench" as const,
      type: (w.status === "needs_input" ? "question" : "review") as AttentionType,
      title: w.title,
      body: w.summary,
      source: "workbench",
      urgency: w.status === "needs_input" ? 25 : 15,
      href: `/m/workbench/${w.id}`,
      createdAt: w.updatedAt,
    })),
  ];

  return sortQueue(rows);
}

export async function countNeedsYou(): Promise<number> {
  const rows = await listNeedsYou();
  return rows.length;
}

export interface PlanBlock {
  kind: "event" | "task" | "do";
  id: string;
  title: string;
  at: Date | null;
  endAt: Date | null;
  allDay: boolean;
  accent: string;
  meetingUrl?: string | null;
  /** For "do" blocks: the project this next-action belongs to. */
  projectId?: string;
  href?: string;
}

/**
 * Plan-my-day data: today's calendar + due tasks (from the shared agenda),
 * plus each active project's next-action as a "do" suggestion. Deterministic
 * and always available; the Daily-planner agent enriches it by raising
 * attention items, it does not gate it.
 */
export async function getToday(): Promise<{
  agenda: AgendaItem[];
  suggestions: PlanBlock[];
}> {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const [agenda, activeProjects] = await Promise.all([
    getAgenda(start, end),
    db
      .select({
        id: projects.id,
        name: projects.name,
        nextAction: projects.nextAction,
      })
      .from(projects)
      .where(and(eq(projects.status, "active"), isNotNull(projects.nextAction)))
      .orderBy(asc(projects.updatedAt))
      .limit(5),
  ]);

  const suggestions: PlanBlock[] = activeProjects
    .filter((p) => p.nextAction)
    .map((p) => ({
      kind: "do" as const,
      id: p.id,
      title: p.nextAction!,
      at: null,
      endAt: null,
      allDay: false,
      accent: "var(--color-solar)",
      projectId: p.id,
      href: `/m/projects/${p.id}`,
    }));

  return { agenda, suggestions };
}

/** Dashboard widget: is today clear, and how many things need you. */
export async function todaySummary() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const [agenda, needs] = await Promise.all([getAgenda(start, end), listNeedsYou()]);
  return {
    events: agenda.filter((a) => a.kind === "event").length,
    dueTasks: agenda.filter((a) => a.kind === "task").length,
    needsYou: needs.length,
  };
}

// Kept for callers that only want open attention items (e.g. a project view).
export async function listAttentionForProject(projectId: string) {
  return db
    .select()
    .from(attentionItems)
    .where(
      and(
        eq(attentionItems.projectRef, `projects:${projectId}`),
        ne(attentionItems.status, "dismissed"),
      ),
    )
    .orderBy(desc(attentionItems.urgency));
}
