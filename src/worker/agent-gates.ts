/**
 * Pre-flight gates for SCHEDULED agent runs — "should this agent even run?"
 *
 * Every cron fire used to pay the full LLM cost regardless of whether anything
 * changed: Project pulse re-read every project on an idle Saturday-shaped day,
 * Repo watcher FAILED (successTool never called) on no-commit days, Follow-up
 * tracker ran with zero meetings to follow up on. Each gate is a cheap
 * deterministic check (SQL or local git — never an LLM call); when it says
 * "nothing to do" the fire is skipped entirely: no run row, no tokens, one
 * log line.
 *
 * Rules of the game:
 *  • Gates apply ONLY to cron fires. A manual "Run now" (run_requests) always
 *    executes — the user asked for it.
 *  • Gates FAIL OPEN: a gate that throws lets the run proceed, so a broken
 *    check can never silence an agent.
 *  • The universal change signal is `search_index.updated_at`, which (since
 *    the skip-unchanged upsert guard) only moves on REAL content changes.
 *  • Keyed by agent NAME — the stable link between a persisted agent row and
 *    its template. Agents without a gate always run (e.g. Loose-ends chaser,
 *    deliberately: slippage accrues precisely when nothing changes, so a
 *    "no changes" skip would invert its purpose).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { agentRuns } from "@/core/db/schema/agents";

const exec = promisify(execFile);

export interface GateResult {
  run: boolean;
  reason: string;
}

type Gate = (lastSuccessAt: Date | null) => Promise<GateResult>;

const RUN = (reason: string): GateResult => ({ run: true, reason });
const SKIP = (reason: string): GateResult => ({ run: false, reason });

/** Any index row of these kinds changed since `since`? */
async function indexChangedSince(
  kinds: string[],
  since: Date,
): Promise<boolean> {
  // Postgres array literal — a bare JS array binds as a tuple, not a text[].
  const kindsArray = `{${kinds.join(",")}}`;
  const rows = await db.execute(dsql`
    select 1 from search_index
     where kind = any(${kindsArray}::text[]) and updated_at > ${since.toISOString()}::timestamptz
     limit 1`);
  return [...rows].length > 0;
}

/** Standard shape: run when the listed kinds changed since the last success. */
function changeGate(kinds: string[], what: string): Gate {
  return async (lastSuccessAt) => {
    if (!lastSuccessAt) return RUN("first run");
    return (await indexChangedSince(kinds, lastSuccessAt))
      ? RUN(`${what} changed since last success`)
      : SKIP(`no ${what} changes since ${lastSuccessAt.toISOString()}`);
  };
}

const GATES: Record<string, Gate> = {
  // Re-derives per-project health from tasks/notes/work. Nothing moved →
  // health can't have moved either.
  "Project pulse": changeGate(
    ["project", "task", "note", "feature", "workbench"],
    "project/task/note",
  ),

  // Chief-of-staff read per project — grounded in the same material, plus
  // fresh repo digests.
  "Project advisor": async (lastSuccessAt) => {
    if (!lastSuccessAt) return RUN("first run");
    if (
      await indexChangedSince(
        ["project", "task", "note", "feature", "file", "attention"],
        lastSuccessAt,
      )
    ) {
      return RUN("project material changed since last success");
    }
    const digests = await db.execute(dsql`
      select 1 from projects
       where repo_digest_at > ${lastSuccessAt.toISOString()}::timestamptz limit 1`);
    if ([...digests].length > 0) return RUN("a repo digest refreshed since last success");
    return SKIP(`no project activity since ${lastSuccessAt.toISOString()}`);
  },

  // Summarizes NEW commits. The read-only clones refresh every 30 min
  // (repo-jobs), so comparing each clone's last commit time against the
  // stored digest time is a purely local check. This also stops the
  // "verification failed: never called recordRepoDigest" pseudo-failures
  // that quiet repos used to produce.
  "Repo watcher": async () => {
    const { usableRepoPath } = await import("@/modules/projects/repo");
    const rows = await db.execute<{
      id: string;
      repo_url: string;
      repo_digest_at: Date | null;
    }>(dsql`
      select id::text, repo_url, repo_digest_at from projects
       where coalesce(repo_url,'') <> '' and status = 'active'`);
    const projects = [...rows];
    if (projects.length === 0) return SKIP("no active project has a repo attached");
    for (const p of projects) {
      const dir = usableRepoPath(p.id, p.repo_url);
      if (!dir) continue; // clone not materialized yet — its sync job will get it
      if (!p.repo_digest_at) return RUN(`repo ${p.id} has no digest yet`);
      try {
        const { stdout } = await exec(
          "git",
          ["-C", dir, "log", "-1", "--format=%ct"],
          { timeout: 10_000 },
        );
        const lastCommit = new Date(parseInt(stdout.trim(), 10) * 1000);
        if (lastCommit > new Date(p.repo_digest_at)) {
          return RUN(`repo ${p.id} has commits newer than its digest`);
        }
      } catch {
        return RUN(`could not read repo ${p.id} — running to be safe`);
      }
    }
    return SKIP("no attached repo has commits newer than its digest");
  },

  // Proposes follow-ups AFTER meetings — no meeting with other people ended
  // since the last success ⇒ nothing to follow up.
  "Follow-up tracker": async (lastSuccessAt) => {
    if (!lastSuccessAt) return RUN("first run");
    const rows = await db.execute(dsql`
      select 1 from calendar_events
       where end_at > ${lastSuccessAt.toISOString()}::timestamptz
         and end_at <= now()
         and attendees is not null and jsonb_array_length(attendees) > 1
       limit 1`);
    return [...rows].length > 0
      ? RUN("meetings ended since last success")
      : SKIP("no meetings with attendees ended since last success");
  },

  // Raises priority on stale/overdue tasks. If no open task is overdue or
  // stale (>7 days old, not already high), there is nothing to flag.
  "Task triage": async () => {
    const rows = await db.execute(dsql`
      select 1 from tasks
       where status in ('todo','doing')
         and (
           (due_at is not null and due_at < now())
           or (created_at < now() - interval '7 days' and priority <> 'high')
         )
       limit 1`);
    return [...rows].length > 0
      ? RUN("open tasks are overdue or going stale")
      : SKIP("no overdue or stale open tasks to flag");
  },

  // Native fallback for the morning briefing: the Claude Desktop routine
  // already posts #my-today to Slack (ingested as a notification) and it
  // lands on the Today briefs panel. Only run when that external brief
  // DIDN'T arrive today.
  "Daily brief": async () => {
    const rows = await db.execute(dsql`
      select 1 from notifications
       where source = 'slack:#my-today'
         and created_at >= date_trunc('day', now())
       limit 1`);
    return [...rows].length > 0
      ? SKIP("the #my-today briefing already arrived today")
      : RUN("no external morning briefing arrived today — running as fallback");
  },

  // Friday synthesis of the week — skip only a completely dead week.
  "Weekly reviewer": async () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    return (await indexChangedSince(
      ["project", "task", "note", "idea", "knowledge", "workbench", "ask"],
      weekAgo,
    ))
      ? RUN("the week had activity")
      : SKIP("nothing changed all week — no material to review");
  },

  // Weekly distillation into memory blocks — an empty week distills nothing.
  "Memory consolidation": changeGate(
    ["project", "task", "note", "idea", "knowledge", "workbench", "ask"],
    "work-state",
  ),
};

/**
 * Decide whether a CRON fire for this agent should execute. No gate → run.
 * Fail open on any gate error.
 */
export async function shouldRunAgent(agent: {
  id: string;
  name: string;
}): Promise<GateResult> {
  const gate = GATES[agent.name];
  if (!gate) return RUN("no gate — always runs");
  try {
    const [last] = await db
      .select({ finishedAt: agentRuns.finishedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agent.id), eq(agentRuns.status, "succeeded")))
      .orderBy(desc(agentRuns.finishedAt))
      .limit(1);
    return await gate(last?.finishedAt ?? null);
  } catch (e) {
    return RUN(`gate errored (${String(e).slice(0, 80)}) — running to be safe`);
  }
}
