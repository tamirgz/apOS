import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { AiToolDef } from "@/core/modules/types.server";
import { sql } from "@/core/db/client";
import { getProjectCockpit, getProjectTasks } from "./queries";
import { boundProjectId, resolveProjectByName } from "./subject";
import { usableRepoPath } from "./repo";
import { projectFiles, projects, PROJECT_HEALTHS, PROJECT_STATUSES } from "./schema";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: Date | null) =>
  d === null ? null : Math.floor((Date.now() - d.getTime()) / DAY);

/**
 * Quality gate for an advisor brief (A2 for insights) — a cheap LOCAL judge.
 * GROUNDED = cites specific evidence + a concrete move; GENERIC = vague
 * boilerplate. Lenient (only fails clear boilerplate) and best-effort: returns
 * null if the judge is unavailable, so it NEVER blocks the run on infra.
 */
async function verifyBriefGrounded(
  state: string,
  recommendation: string,
): Promise<boolean | null> {
  try {
    // Model is the `insight.verify` route — configurable in Settings; a cheap
    // local judge by default.
    const { resolveRoute } = await import("@/core/ai/routing");
    const { db } = await import("@/core/db/client");
    const route = await resolveRoute("insight.verify");
    let text = "";
    for await (const ev of route.provider.run({
      system:
        "You gate a project-advisor brief for QUALITY. GROUNDED = it cites specific evidence (a named task, a number, days idle, a recent commit, a concrete blocker) AND gives a concrete next move. GENERIC = vague boilerplate ('keep up the good work', 'stay focused', 'continue making progress') with no specifics. Be lenient — only say GENERIC when it is clearly vague. Answer with ONE word: GROUNDED or GENERIC.",
      messages: [
        { role: "user", content: `STATE: ${state}\nRECOMMENDATION: ${recommendation}` },
      ],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
    })) {
      if (ev.type === "done") text = ev.text;
    }
    if (/\bGENERIC\b/i.test(text) && !/\bGROUNDED\b/i.test(text)) return false;
    return true;
  } catch {
    return null;
  }
}

export const projectTools: AiToolDef[] = [
  {
    name: "projects.create",
    description:
      "Create a new project. Use for any multi-task effort the user wants to track.",
    input: z.object({
      name: z.string().min(1).describe("Short project name"),
      description: z
        .string()
        .optional()
        .describe("One-line summary of the project's goal"),
    }),
    async execute(input, { db }) {
      const [row] = await db
        .insert(projects)
        .values({
          name: input.name,
          description: input.description ?? null,
        })
        .returning();
      return { created: { id: row.id, name: row.name } };
    },
  },
  {
    name: "projects.list",
    description:
      "List projects with their L2 cockpit rollup: status, goal, next action, resolved health + reason, open/done/overdue task counts, and days since last activity. This is the world model — read it before deciding what needs attention.",
    input: z.object({}),
    async execute(_input, { db }) {
      const rows = await getProjectCockpit(db);
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        goal: p.goal,
        nextAction: p.nextAction,
        health: p.resolvedHealth.health,
        healthReason: p.resolvedHealth.reason,
        healthSource: p.resolvedHealth.source,
        tasks: {
          open: p.taskCounts.open,
          done: p.taskCounts.done,
          overdue: p.taskCounts.overdue,
        },
        notes: p.noteCount,
        daysSinceActivity: daysAgo(p.lastActivityAt),
      }));
    },
  },
  {
    name: "projects.focusNext",
    description:
      "Iterate your active projects ONE at a time. Each call focuses the next active project — the backbone picks it, you never choose or type an id — and returns its full read: goal, health, task counts, days idle, and its open tasks. Do your per-project work on the focused project (projects.setHealth / setGoal / setNextAction / setAdvisorBrief / recordRepoDigest / attention.raise all target it automatically, with NO id argument), then call projects.focusNext again. Returns { done: true } once every active project has been visited. Pass { withRepo: true } for a repo-focused run (e.g. recording repo digests) to iterate ONLY projects that have a code repo — so you never land on one with nothing to read. This is the ONLY correct way to loop projects: because you never handle an id, a judgement can never land on the wrong project.",
    input: z.object({
      withRepo: z
        .boolean()
        .optional()
        .describe(
          "Only iterate projects that have a code repo attached — for repo-focused runs, so you never land on a project with nothing to read.",
        ),
    }),
    async execute(input, ctx) {
      // Build the queue once: the backbone owns the SET (active projects) and
      // the ORDER, so the model iterates without ever selecting an entity. The
      // withRepo filter (set on the first call) narrows the set to projects with
      // an attached repo, so a repo-only run never has to skip empties.
      if (!ctx.subjectCursor) {
        const all = await getProjectCockpit(ctx.db);
        let active = all.filter((p) => p.status === "active");
        if (input.withRepo) {
          const repoIds = new Set(
            (
              await ctx.db
                .select({ id: projects.id })
                .from(projects)
                .where(and(isNotNull(projects.repoUrl), ne(projects.repoUrl, "")))
            ).map((r) => r.id),
          );
          active = active.filter((p) => repoIds.has(p.id));
        }
        const items = active.map((p) => ({
            id: p.id,
            name: p.name,
            read: {
              name: p.name,
              goal: p.goal,
              nextAction: p.nextAction,
              health: p.resolvedHealth.health,
              healthReason: p.resolvedHealth.reason,
              tasks: {
                open: p.taskCounts.open,
                done: p.taskCounts.done,
                overdue: p.taskCounts.overdue,
              },
              notes: p.noteCount,
              daysSinceActivity: daysAgo(p.lastActivityAt),
            } as Record<string, unknown>,
          }));
        ctx.subjectCursor = { kind: "project", items, index: 0 };
      }
      const cur = ctx.subjectCursor;
      if (cur.index >= cur.items.length) {
        ctx.subject = null;
        return { done: true, visited: cur.items.length };
      }
      const it = cur.items[cur.index++];
      ctx.subject = { kind: "project", id: it.id, name: it.name };
      // Attach the focused project's tasks so the model has real evidence
      // (titles, priority, due dates) without ever handling a project id. Open
      // tasks feed the derived next-action; the recently-completed ones let the
      // pulse write an "[Advise] …" next step when nothing is open.
      const all = await getProjectTasks(it.id, ctx.db);
      const openTasks = all
        .filter((t) => t.status !== "done")
        .slice(0, 20)
        .map((t) => ({
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueAt: t.dueAt,
        }));
      const recentlyCompleted = all
        .filter((t) => t.status === "done")
        .sort(
          (a, b) =>
            (b.completedAt ? +new Date(b.completedAt) : 0) -
            (a.completedAt ? +new Date(a.completedAt) : 0),
        )
        .slice(0, 8)
        .map((t) => ({ title: t.title, completedAt: t.completedAt }));
      // Per-subject scoped recall: the lessons/knowledge/notes most relevant to
      // THIS project, so a per-project judgement (health, advisor brief) is
      // grounded in accumulated wisdom about it — not generic. Bounded, best-effort.
      let relevantMemory: { kind: string; text: string }[] = [];
      try {
        const { recallSemantic } = await import("@/core/memory");
        const goal = (it.read as { goal?: string | null }).goal ?? "";
        const hits = await recallSemantic(`${it.name}. ${goal}`.slice(0, 300), {
          kinds: ["memory", "knowledge", "note", "vault"],
          limit: 3,
        });
        relevantMemory = hits.map((h) => ({ kind: h.kind, text: h.text }));
      } catch {
        // best-effort — recall must never break iteration
      }
      return {
        focused: it.name,
        project: { ...it.read, openTasks, recentlyCompleted, relevantMemory },
        remaining: cur.items.length - cur.index,
      };
    },
  },
  {
    name: "projects.setStatus",
    description:
      "Set a project's status (active | paused | done). Identify the project by its NAME (validated) — never a raw id.",
    input: z.object({
      project: z.string().describe("Project NAME, validated server-side"),
      status: z.enum(PROJECT_STATUSES),
    }),
    async execute(input, ctx) {
      const p = await resolveProjectByName(ctx, input.project);
      if ("error" in p) return p;
      const [row] = await ctx.db
        .update(projects)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(projects.id, p.id))
        .returning();
      return row
        ? { updated: { id: row.id, status: row.status } }
        : { error: "project not found" };
    },
  },
  {
    name: "projects.setHealth",
    description:
      "Record your judgement of the FOCUSED project's health with a one-line reason (it targets the project from projects.focusNext — you pass no id). Use 'blocked' when it's waiting on someone/something external (the read-time heuristic can never infer that). Prefer this over letting the heuristic guess.",
    input: z.object({
      id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Omit in an agent run — the focused project is targeted. (Chat only: the project id.)",
        ),
      health: z.enum(PROJECT_HEALTHS),
      reason: z
        .string()
        .min(3)
        .max(120)
        .describe("One line: why this health, in plain words"),
    }),
    async execute(input, ctx) {
      const t = boundProjectId(ctx, input.id);
      if ("error" in t) return t;
      // Deliberately does NOT touch updatedAt: the agent assessing a project is
      // not user activity, so it must not reset the stall clock.
      const [row] = await ctx.db
        .update(projects)
        .set({
          health: input.health,
          healthReason: input.reason.trim(),
          healthUpdatedAt: new Date(),
        })
        .where(eq(projects.id, t.id))
        .returning();
      return row
        ? { updated: { id: row.id, health: row.health } }
        : { error: "project not found" };
    },
  },
  {
    name: "projects.setGoal",
    description:
      "Set the FOCUSED project's north-star outcome (one line) when it has none, so it has a clear 'why' (targets the project from projects.focusNext — you pass no id). Don't overwrite a goal the user already wrote unless it's clearly wrong.",
    input: z.object({
      id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Omit in an agent run — the focused project is targeted. (Chat only: the project id.)",
        ),
      goal: z.string().min(3).max(160),
    }),
    async execute(input, ctx) {
      const t = boundProjectId(ctx, input.id);
      if ("error" in t) return t;
      const [row] = await ctx.db
        .update(projects)
        .set({ goal: input.goal.trim() })
        .where(eq(projects.id, t.id))
        .returning();
      return row
        ? { updated: { id: row.id, goal: row.goal } }
        : { error: "project not found" };
    },
  },
  {
    name: "projects.listFiles",
    description:
      "List the files attached to a project (filename, size, and whether their text was extracted). Use before answering questions about a project's specs/docs — search.everything already covers their content by meaning, this is for a direct inventory.",
    input: z.object({
      project: z
        .string()
        .optional()
        .describe("Project NAME (validated); omit in a focused agent run to use the focused project"),
    }),
    async execute(input, ctx) {
      const pid =
        ctx.subject?.kind === "project" ? ctx.subject.id : undefined;
      let projectId = pid;
      if (!projectId) {
        const p = await resolveProjectByName(ctx, input.project);
        if ("error" in p) return p;
        projectId = p.id;
      }
      const rows = await ctx.db
        .select({
          id: projectFiles.id,
          filename: projectFiles.filename,
          sizeBytes: projectFiles.sizeBytes,
          status: projectFiles.status,
        })
        .from(projectFiles)
        .where(eq(projectFiles.projectId, projectId));
      return rows;
    },
  },
  {
    name: "projects.readRepo",
    description:
      "Read the FOCUSED project's attached code repo — recent commits + its README — so your advice is grounded in the actual code, not a guess (targets the project from projects.focusNext; you pass no id). Returns attached:false when no repo is attached or it hasn't cloned yet.",
    input: z.object({
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Omit in an agent run — the focused project is read. (Chat only.)"),
    }),
    async execute(input, ctx) {
      const projectId = ctx.subject?.kind === "project" ? ctx.subject.id : input.projectId;
      if (!projectId)
        return { error: "No project focused. Call projects.focusNext first." };
      const [p] = await ctx.db
        .select({ repoUrl: projects.repoUrl })
        .from(projects)
        .where(eq(projects.id, projectId));
      const dir = usableRepoPath(projectId, p?.repoUrl ?? null);
      if (!dir) return { attached: false, note: "no repo attached or not cloned yet" };
      const exec = promisify(execFile);
      let recentCommits = "";
      let readme = "";
      try {
        recentCommits = (
          await exec("git", ["-C", dir, "log", "--oneline", "-20"], {
            maxBuffer: 4 * 1024 * 1024,
          })
        ).stdout.trim();
      } catch {
        // shallow/odd repo — commits are optional context
      }
      try {
        const name = readdirSync(dir).find((n) => /^readme(\.md|\.rst|\.txt)?$/i.test(n));
        if (name) readme = readFileSync(join(dir, name), "utf8").slice(0, 4000);
      } catch {
        // no README — fine
      }
      return { attached: true, recentCommits, readme };
    },
  },
  {
    name: "projects.setAdvisorBrief",
    description:
      "Record the chief-of-staff read for the FOCUSED project: where it actually stands (state), the single real blocker (or null if none), and one concrete recommended next move (targets the project from projects.focusNext — you pass no id). Ground every field in the project's real tasks/notes/repo — no boilerplate, no restating the goal.",
    input: z.object({
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Omit in an agent run — the focused project is targeted. (Chat only.)"),
      state: z
        .string()
        .min(3)
        .max(600)
        .describe("2-3 sentences: where this project actually stands right now"),
      blocker: z
        .string()
        .max(400)
        .nullish()
        .describe("The one real blocker holding it up, or null if nothing is blocking"),
      recommendation: z
        .string()
        .min(3)
        .max(400)
        .describe("One concrete next move you'd make"),
    }),
    async execute(input, ctx) {
      const t = boundProjectId(ctx, input.projectId);
      if ("error" in t) return t;
      // Insight quality gate — reject a generic/ungrounded read so the advisor
      // rewrites it with real evidence (LOCAL judge; never blocks on infra).
      const grounded = await verifyBriefGrounded(input.state, input.recommendation);
      if (grounded === false) {
        return {
          error:
            "This read is too generic. Cite specific evidence in `state` (a named task, a number, days idle, a recent commit) and make `recommendation` a concrete move — then call setAdvisorBrief again.",
        };
      }
      const [row] = await ctx.db
        .update(projects)
        .set({
          advisorState: input.state.trim(),
          advisorBlocker: input.blocker?.trim() || null,
          advisorNext: input.recommendation.trim(),
          advisorUpdatedAt: new Date(),
        })
        .where(eq(projects.id, t.id))
        .returning();
      if (row) await sql.notify("projects_changed", t.id); // live cockpit update
      return row ? { updated: { id: row.id } } : { error: "project not found" };
    },
  },
  {
    name: "projects.recordRepoDigest",
    description:
      "Record a short 'what's moving in the code' digest for the FOCUSED project from its recent commits (2-3 sentences: themes, notable changes, momentum). Targets the project from projects.focusNext — you pass no id. Call once per project that has a code repo.",
    input: z.object({
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Omit in an agent run — the focused project is targeted. (Chat only.)"),
      digest: z
        .string()
        .min(3)
        .max(600)
        .describe("2-3 sentences on what the recent commits actually did"),
    }),
    async execute(input, ctx) {
      const t = boundProjectId(ctx, input.projectId);
      if ("error" in t) return t;
      const [row] = await ctx.db
        .update(projects)
        .set({ repoDigest: input.digest.trim(), repoDigestAt: new Date() })
        .where(eq(projects.id, t.id))
        .returning();
      if (row) await sql.notify("projects_changed", t.id);
      return row ? { updated: { id: row.id } } : { error: "project not found" };
    },
  },
];
