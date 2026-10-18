/**
 * Routines (A1 · Work Kernel) — the recurring half of the Workbench.
 *
 * A routine fires (on a new commit or a schedule), spawns an ordinary Workbench
 * task from its standing ask, and lets the existing engine take it from there:
 * git isolation → the verifying judge → approval-gated PR delivery. Nothing
 * here touches the repo; the only way work reaches it is a PR the user approves.
 *
 * The commit trigger is idempotent via `lastSeenSha` (the processed-ledger
 * rule): a routine fires once per genuinely-new HEAD, and a first observation
 * only sets the baseline — it never fires on attach.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { routines, taskAttempts, workbenchTasks } from "./schema";

const exec = promisify(execFile);
const log = (m: string) =>
  console.log(`[routines ${new Date().toISOString()}] ${m}`);

const LOCAL_EXECUTORS = new Set(["opencode", "pi"]);

async function headSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** HEAD sha + subject line, for grounding a routine run in the actual commit. */
async function headCommit(repoPath: string): Promise<{ sha: string; subject: string } | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", "-1", "--format=%H %s"],
      { cwd: repoPath },
    );
    const _line = stdout.trim();
    const _sha = _line.slice(0, 40);
    return /^[0-9a-f]{40}$/i.test(_sha) ? { sha: _sha, subject: _line.slice(41) } : null;
  } catch {
    return null;
  }
}

/**
 * A routine's ask is a STANDING, recurring instruction ("on each commit …").
 * A single run needs to know WHICH commit and that it acts NOW — so we prepend
 * only that: the just-landed commit to analyze, then the user's ask verbatim.
 * This is the one addition that's actually load-bearing (it's why the user
 * never has to name a commit — apOS supplies it). The "don't build a git hook"
 * guard is NOT repeated here; it already lives in the CLI executor preamble
 * where local models need it, and Claude never needed it.
 */
/** What fired this run — a commit, or an incoming source item (a post). */
export type TriggerCtx =
  | { kind: "commit"; sha: string; subject: string }
  | { kind: "post"; text: string; linkedText?: string | null; url?: string | null }
  | null;

function runPromptFor(ask: string, ctx: TriggerCtx): string {
  let head: string;
  if (ctx?.kind === "commit") {
    head = `The latest commit on this repository just landed — ${ctx.sha.slice(0, 10)} "${ctx.subject}". Inspect its changes and carry out the following now, over the current state of the repo:`;
  } else if (ctx?.kind === "post") {
    head =
      "A new post arrived from the source you watch. Act on THIS post now, over the current state of the repo.\n\n" +
      "--- POST ---\n" +
      ctx.text +
      (ctx.url ? `\n(link: ${ctx.url})` : "") +
      (ctx.linkedText ? `\n\n--- LINKED ARTICLE ---\n${ctx.linkedText}` : "") +
      "\n--- END ---\n\nCarry out the following for this post:";
  } else {
    head = "Carry out the following now, over the current state of the repo:";
  }
  return `${head}\n\n${ask}`;
}

/**
 * Fire one routine: spawn a Workbench task from its ask and hand it to the
 * engine. Tagged `routines:<id>` so the engine knows to queue a PR on a pass.
 * `ctx` is the trigger payload (a commit or a source post); for a plain
 * commit-triggered run it's derived from HEAD if not supplied.
 */
export async function fireRoutine(
  routineId: string,
  ctx?: TriggerCtx,
): Promise<void> {
  const [r] = await db.select().from(routines).where(eq(routines.id, routineId));
  if (!r || r.enabled !== "true") return;
  if (!r.repoPath) {
    log(`routine ${r.name} has no repo — skipped`);
    return;
  }

  const taskType = LOCAL_EXECUTORS.has(r.executorId) ? "code-local" : "code";
  // Ground the run in what fired it. A source routine is handed its post; a
  // commit routine falls back to HEAD. Either way it's imperative-now.
  let runCtx: TriggerCtx = ctx ?? null;
  if (!runCtx) {
    const c = await headCommit(r.repoPath);
    runCtx = c ? { kind: "commit", sha: c.sha, subject: c.subject } : null;
  }
  const runPrompt = runPromptFor(r.prompt, runCtx);
  const [task] = await db
    .insert(workbenchTasks)
    .values({
      title: `${r.name}`.slice(0, 90),
      prompt: runPrompt,
      taskType,
      repoPath: r.repoPath,
      createdFrom: `routines:${r.id}`,
    })
    .returning();

  const [attempt] = await db
    .insert(taskAttempts)
    .values({
      taskId: task.id,
      seq: 1,
      executorId: r.executorId,
      model: r.model ?? null,
    })
    .returning();

  await db
    .update(routines)
    .set({ lastFiredAt: new Date(), lastTaskId: task.id, updatedAt: new Date() })
    .where(eq(routines.id, r.id));

  await sql.notify("workbench_run", attempt.id);
  await sql.notify("routines_changed", r.id);
  log(`fired "${r.name}" → task ${task.id.slice(0, 8)} (${r.executorId})`);
}

/**
 * Commit trigger: for every enabled commit/both routine, sync its repo and fire
 * if HEAD moved past the ledger. A null ledger just records the baseline — the
 * routine watches for the NEXT commit, it doesn't fire on the current one.
 */
export async function checkCommitTriggers(): Promise<void> {
  const rows = await db
    .select()
    .from(routines)
    .where(inArray(routines.triggerKind, ["commit", "both"]));

  const { syncProjectRepo } = await import("@/modules/projects/repo");
  const { projects } = await import("@/modules/projects/schema");
  for (const r of rows) {
    if (r.enabled !== "true" || !r.repoPath || !r.projectId) continue;
    // Freshen the cache clone so HEAD reflects the user's latest push/commit.
    const [p] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, r.projectId));
    if (p?.repoUrl) await syncProjectRepo(r.projectId, p.repoUrl).catch(() => {});
    const head = await headSha(r.repoPath);
    if (!head) continue;

    if (!r.lastSeenSha) {
      await db
        .update(routines)
        .set({ lastSeenSha: head, updatedAt: new Date() })
        .where(and(eq(routines.id, r.id), isNull(routines.lastSeenSha)));
      log(`baseline set for "${r.name}" @ ${head.slice(0, 8)} (won't fire on attach)`);
      continue;
    }
    if (head !== r.lastSeenSha) {
      const oldSha = r.lastSeenSha;
      // Compare-and-swap the ledger: only the caller that actually advances it
      // from the sha we observed fires. Two concurrent sweeps that saw the same
      // old sha can't both win, so a new commit fires exactly one run.
      const claimed = await db
        .update(routines)
        .set({ lastSeenSha: head, updatedAt: new Date() })
        .where(and(eq(routines.id, r.id), eq(routines.lastSeenSha, r.lastSeenSha)))
        .returning({ id: routines.id });
      if (!claimed.length) continue;

      // Attention filter: a free/local model judges whether this change touches
      // anything the routine documents before the (possibly expensive) executor
      // runs. gateEnabled=false always runs; a manual "run now" bypasses this.
      if (r.gateEnabled === "true") {
        const { diffRange } = await import("./git");
        const { classifyCommitRelevance } = await import("./gate");
        const diff = await diffRange(r.repoPath, oldSha, head).catch(() => ({
          files: [] as string[],
          patch: "",
        }));
        const verdict = await classifyCommitRelevance(r, diff);
        if (!verdict.relevant) {
          await db
            .update(routines)
            .set({
              lastGateRelevant: "false",
              lastGateWhy: verdict.why,
              gateSkipped: r.gateSkipped + 1,
              updatedAt: new Date(),
            })
            .where(eq(routines.id, r.id));
          log(`gate SKIP "${r.name}" @ ${head.slice(0, 8)}: ${verdict.why}`);
          await sql.notify("routines_changed", r.id);
          continue;
        }
        await db
          .update(routines)
          .set({
            lastGateRelevant: "true",
            lastGateWhy: verdict.why,
            gateRan: r.gateRan + 1,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, r.id));
        log(`gate PASS "${r.name}" @ ${head.slice(0, 8)}: ${verdict.why} → running`);
      }
      await fireRoutine(r.id);
    }
  }
}

/**
 * Queue an approval-gated PR for a routine-spawned task that passed the judge.
 * Delegated work never reaches the repo directly — this parks the push+PR in
 * the approval queue, and it happens only on the user's explicit yes.
 */
export async function queuePrApproval(taskId: string): Promise<void> {
  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, taskId));
  if (!task?.createdFrom?.startsWith("routines:")) return;
  const routineId = task.createdFrom.slice("routines:".length);
  const [r] = await db.select().from(routines).where(eq(routines.id, routineId));
  if (!r || r.deliverPr !== "true") return;

  const { approvals } = await import("@/core/db/schema/approvals");
  const { openPRInput } = await import("./tools");
  const title = `apOS routine: ${r.name}`.slice(0, 120);
  const body = [
    `Automated by the apOS routine **${r.name}**.`,
    "",
    task.summary ? `**What changed:** ${task.summary}` : "",
    "",
    "_Review before merge — apOS proposes, it never merges._",
  ]
    .filter(Boolean)
    .join("\n");

  const [row] = await db
    .insert(approvals)
    .values({
      agentId: r.id,
      runId: task.id,
      agentName: r.name,
      toolName: "workbench.openPR",
      // One stable branch per routine → one PR that updates each run, instead
      // of a fresh PR per commit piling up.
      input: openPRInput.parse({
        taskId,
        title,
        body,
        prBranch: `aios/routine-${r.id}`,
        routineId: r.id,
      }),
    })
    .returning();
  await sql.notify("approvals_changed", row.id);
  const { notify } = await import("@/core/notify");
  await notify({
    title: `PR ready for approval: ${r.name}`,
    body: `The routine's change passed verification. Approve to push the branch and open the PR.`,
    level: "warn",
    source: `routine:${r.name}`,
    href: "/m/today",
  });
  log(`queued PR approval for task ${taskId.slice(0, 8)} (routine ${r.name})`);
}

/** Latest task a routine spawned — for the PR title/body context. */
export async function latestRoutineTask(routineId: string) {
  const [t] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.createdFrom, `routines:${routineId}`))
    .orderBy(desc(workbenchTasks.createdAt))
    .limit(1);
  return t ?? null;
}

/**
 * Source trigger: a relevance-passed post just arrived. Fire every enabled
 * "source" routine bound to that post's channel, handing it the post as the
 * run context. The channel binding is a text ref ("telegram:<channel>"), so
 * workbench stays loosely coupled to the telegram module.
 */
export async function fireSourceRoutines(postId: string): Promise<void> {
  const { telegramPosts } = await import("@/modules/telegram/schema");
  const [post] = await db
    .select()
    .from(telegramPosts)
    .where(eq(telegramPosts.id, postId));
  if (!post) return;

  const ref = `telegram:${post.channel}`;
  const rows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.triggerKind, "source"), eq(routines.sourceRef, ref)));
  for (const r of rows) {
    if (r.enabled !== "true") continue;
    await fireRoutine(r.id, {
      kind: "post",
      text: post.text,
      linkedText: post.linkedText,
      url: post.urls[0] ?? null,
    }).catch((e) => log(`source routine ${r.id} failed: ${e}`));
  }
}

export const routineJobs: ModuleJob[] = [
  {
    // NOTIFY-driven "run now" for a routine.
    channel: "routines_run",
    handle: async (payload) => {
      if (payload) await fireRoutine(payload);
    },
  },
  {
    // Commit-trigger sweep. Idempotent via lastSeenSha, so re-running is safe.
    channel: "routines_commit_sweep",
    schedule: "*/5 * * * *",
    handle: async () => {
      await checkCommitTriggers();
    },
  },
  {
    // A relevance-passed Telegram post → fire the source routine(s) for it.
    channel: "telegram_new_post",
    handle: async (payload) => {
      if (payload) await fireSourceRoutines(payload);
    },
  },
];
