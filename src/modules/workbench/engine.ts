/**
 * Workbench engine — runs inside the worker.
 *
 * Responsibilities the adapters must never own: claiming an attempt exactly
 * once, git isolation, wall-clock timeouts, process-group kills, and
 * reconciling attempts that a worker restart left running. Adapters only
 * translate their executor's output into normalized events.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { claudeHeadlessAdapter } from "./adapters/claude-headless";
import { codexHeadlessAdapter } from "./adapters/codex-headless";
import {
  AIOS_OPENCODE_CONFIG,
  AIOS_OPENCODE_DIR,
  cliAdapter,
  type CliParser,
} from "./adapters/cli";
import { TIMEOUTS } from "./defaults";
import { assertFreeModel, normalizeModelForExecutor } from "./models";
import { nativeAdapter } from "./adapters/native";
import { researchAdapter } from "./adapters/research";
import { gatherResearchContext } from "./research";
import type { Adapter, AdapterEvent } from "./adapters/types";
import { executorAvailability } from "./adapters/capabilities";
import { harnessHome } from "./adapters/sandbox";
import { setupLocalAgent } from "./adapters/local-agents";
import {
  commitCheckpoint,
  createClone,
  createWorktree,
  fetchBranchFromClone,
  diffSince,
  isGitRepo,
  SCRATCH_ROOT,
} from "./git";
import {
  attemptEvents,
  executors,
  taskAttempts,
  workbenchTasks,
} from "./schema";

/** Ollama serves one model at a time; two heavy attempts thrash the machine. */
/**
 * Concurrency is split into two pools, because the two kinds of executor have
 * opposite scaling limits:
 *  - LOCAL (cli → Ollama): Ollama serves one model at a time, so a second heavy
 *    local run just thrashes the machine (model swap-in/out). One slot.
 *  - CLOUD (claude-headless / codex / native): these call out to a hosted model
 *    and parallelize fine. Several slots.
 * The point: a long local routine can no longer block your Claude tasks, and
 * vice-versa — each pool drains independently.
 */
const POOL_LIMITS = { local: 1, cloud: 4 } as const;
type Pool = keyof typeof POOL_LIMITS;
const MAX_QUEUE_PICKUP = POOL_LIMITS.local + POOL_LIMITS.cloud;

/** A cli executor runs a local Ollama model; everything else is a cloud call. */
async function poolOf(executorId: string): Promise<Pool> {
  const [e] = await db
    .select({ kind: executors.kind })
    .from(executors)
    .where(eq(executors.id, executorId));
  return e?.kind === "cli" ? "local" : "cloud";
}
/** Run ids arrive as raw NOTIFY payloads; reject anything that isn't a uuid so
 * a malformed payload fails cleanly instead of corrupting the query params. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No progress (no event) for this long = the run is genuinely stuck, not slow. */
const STALL_LIMIT_MS = 60 * 60 * 1000; // 1 hour

/** True if a process with this pid is still alive (a cheap signal-0 probe). */
function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ADAPTERS: Record<string, Adapter> = {
  "claude-headless": claudeHeadlessAdapter,
  "codex-headless": codexHeadlessAdapter,
  native: nativeAdapter,
  cli: cliAdapter,
  research: researchAdapter,
};

const log = (m: string) =>
  console.log(`[workbench ${new Date().toISOString()}] ${m}`);

/**
 * apOS keeps its own opencode config rather than editing the user's: theirs
 * carries personal MCP servers and credentials, and a headless run must not
 * depend on those being reachable. `OPENCODE_CONFIG` points opencode here.
 *
 * The Ollama provider block below is the verified shape from opencode's own
 * published schema (ProviderConfig: npm + options.baseURL + models).
 */
async function writeOpencodeConfig(workdir: string): Promise<void> {
  const models: Record<string, { name: string }> = {};
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json()) as { models?: { name: string }[] };
    for (const m of data.models ?? []) models[m.name] = { name: m.name };
  } catch {
    // Ollama down — seed the coder models so the config is still valid.
    models["qwen3-coder:30b"] = { name: "qwen3-coder:30b" };
    models["qwen2.5-coder:7b"] = { name: "qwen2.5-coder:7b" };
  }

  await mkdir(AIOS_OPENCODE_DIR, { recursive: true });
  await writeFile(
    AIOS_OPENCODE_CONFIG,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        // Turn off the user's global MCP servers for apOS runs: a headless run
        // must not block on a slow local `mgrep mcp` sync or a remote MCP
        // handshake during init. apOS's config merges over the global one, so
        // these disables win.
        mcp: {
          mgrep: { type: "local", command: ["mgrep", "mcp"], enabled: false },
          "n8n-mcp": {
            type: "remote",
            url: "https://n8ntg.vps.webdock.cloud/n8n-mcp/mcp",
            enabled: false,
          },
        },
        // Turn off two tools that derail a small local model on a focused edit.
        // `skill` exposes the user's global ~/.claude/skills — a doc-sync run
        // burned itself trying to call a `git` skill, then read the skill list
        // (dockerized-ollama-agent, graphify, …) and wandered off hunting
        // "Dockerfiles", hallucinated an out-of-repo path, and changed nothing.
        // `task` spawns subagents apOS doesn't want here. With both off the
        // model is left with just the file tools and stays on the actual task.
        tools: {
          skill: false,
          task: false,
        },
        provider: {
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            name: "Ollama (local)",
            // Host-run agents talk to Ollama on localhost; only containers
            // need host.docker.internal.
            options: { baseURL: "http://localhost:11434/v1", apiKey: "ollama" },
            models,
          },
        },
        // Unattended runs can't answer prompts. Edits are safe because the
        // engine confines every attempt to a throwaway git worktree.
        //
        permission: {
          read: "allow",
          edit: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          bash: "allow",
          // A linked worktree's .git is a *file* pointing at the main repo, so
          // opencode resolves the project root there and treats the worktree
          // itself as external — which silently blocked every write. Allow
          // exactly this attempt's directory, and nothing else: a local model
          // that invents "/world.txt" (observed) still gets stopped.
          external_directory: {
            [`${workdir}/**`]: "allow",
            [workdir]: "allow",
            "*": "deny",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** Seeded once so Settings has rows to edit and the engine has defaults. */
export async function ensureExecutors() {
  await db
    .insert(executors)
    .values([
      {
        id: "claude-headless",
        name: "Claude Code (headless)",
        kind: "claude-headless" as const,
        defaultModel: "claude-sonnet-5",
        gitMode: "worktree" as const,
        timeoutMs: TIMEOUTS.code,
      },
      {
        // GPT-5 via a ChatGPT Pro subscription (no API key) — the second
        // "hard task" brain alongside Claude. Auth: `codex login`.
        id: "codex-headless",
        name: "Codex (GPT-5, ChatGPT sub)",
        kind: "codex-headless" as const,
        defaultModel: "gpt-5.6-sol",
        gitMode: "worktree" as const,
        timeoutMs: TIMEOUTS.code,
      },
      {
        id: "native",
        name: "apOS native (module tools)",
        kind: "native" as const,
        defaultModel: null,
        gitMode: "none" as const,
        timeoutMs: TIMEOUTS.docs,
      },
      // ── W2: local coding agents, as configuration rather than code ──────
      {
        id: "opencode",
        name: "opencode (local + free cloud)",
        kind: "cli" as const,
        // {{model}} carries the full provider/model spec (ollama/…, opencode/…,
        // nvidia/…) so any free model in opencode's library works, not just
        // local. --dangerously-skip-permissions auto-approves anything not
        // *explicitly* denied, so the external_directory deny rule still holds;
        // without it a headless "write" falls through to "ask" and is dropped.
        commandTemplate:
          "opencode run --format json --dangerously-skip-permissions --model {{model}} {{prompt}}",
        parser: "jsonl" as const,
        defaultModel: "ollama/qwen3.5:35b-a3b-coding-nvfp4",
        gitMode: "worktree" as const,
        timeoutMs: TIMEOUTS["code-local"],
      },
      {
        id: "pi",
        name: "pi + local model",
        kind: "cli" as const,
        commandTemplate:
          "pi --provider ollama --model {{model}} --mode json -p {{prompt}}",
        parser: "pi-json" as const,
        defaultModel: "qwen2.5-coder:7b",
        gitMode: "worktree" as const,
        timeoutMs: TIMEOUTS["code-local"],
      },
      // Qwen Code — tuned for the local Qwen coder models. Reaches Ollama via its
      // OpenAI-compatible provider (env supplied by setupLocalAgent); the model
      // rides OPENAI_MODEL, so the template needs no {{model}}. Text output →
      // the diff is the deliverable, the final message is the headline.
      {
        id: "qwen",
        name: "Qwen Code (local Ollama)",
        kind: "cli" as const,
        commandTemplate: "qwen -y -o text -p {{prompt}}",
        parser: "text" as const,
        defaultModel: "ollama/qwen3.5:35b-a3b-coding-nvfp4",
        gitMode: "worktree" as const,
        timeoutMs: TIMEOUTS["code-local"],
      },
      // Factory Droid — BYOK Ollama custom model provisioned into the sandbox
      // ~/.factory/config.json by setupLocalAgent; "aios-ollama" → the fixed id
      // "custom:aios-ollama-0". Runs local at zero Factory cost.
      {
        id: "droid",
        name: "Factory Droid (local Ollama)",
        kind: "cli" as const,
        commandTemplate:
          "droid exec -m custom:aios-ollama-0 --skip-permissions-unsafe --cwd {{workdir}} -o text {{prompt}}",
        parser: "text" as const,
        defaultModel: "ollama/qwen3.5:35b-a3b-coding-nvfp4",
        gitMode: "worktree" as const,
        timeoutMs: TIMEOUTS["code-local"],
      },
    ])
    .onConflictDoNothing();

  // aider was removed: it's a SEARCH/REPLACE editor, not an agentic loop, so it
  // can't analyze a commit the way this delegation needs; it also loads whole
  // files (these docs are ~57k tokens of embedded font → request timeouts) and
  // pulls its own commit-message model. opencode fills the local-CLI-agent role.
  await db.delete(executors).where(eq(executors.id, "aider"));

  // Migrate an opencode row seeded before full-spec models: the old template
  // hardcoded `ollama/{{model}}` and stored a bare tag, which can't reach the
  // free cloud models. onConflictDoNothing above never touches an existing
  // row, so fix it explicitly and idempotently.
  await db
    .update(executors)
    .set({
      name: "opencode (local + free cloud)",
      commandTemplate:
        "opencode run --format json --dangerously-skip-permissions --model {{model}} {{prompt}}",
      defaultModel: "ollama/qwen3.5:35b-a3b-coding-nvfp4",
    })
    .where(
      and(
        eq(executors.id, "opencode"),
        dsql`${executors.commandTemplate} like '%--model ollama/{{model}}%'`,
      ),
    );
}

async function emitEvent(attemptId: string, e: AdapterEvent) {
  await db.insert(attemptEvents).values({
    attemptId,
    type: e.type,
    payload: e.payload,
  });
  await db
    .update(taskAttempts)
    .set({ heartbeatAt: new Date() })
    .where(eq(taskAttempts.id, attemptId));
}

async function notifyChanged(taskId: string) {
  await sql.notify("workbench_changed", taskId);
}

async function setTask(
  taskId: string,
  patch: Partial<typeof workbenchTasks.$inferInsert>,
) {
  await db
    .update(workbenchTasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workbenchTasks.id, taskId));
  await notifyChanged(taskId);
}

/**
 * Run one attempt. Safe to call twice for the same id — the claim is an
 * atomic queued→running transition, so the NOTIFY path and the pickup sweep
 * cannot double-execute.
 */
export async function runAttempt(attemptId: string): Promise<void> {
  if (!UUID_RE.test(attemptId)) {
    log(`ignoring malformed attempt id: ${JSON.stringify(attemptId).slice(0, 60)}`);
    return;
  }
  // Which pool does THIS attempt belong to? (peek without claiming)
  const [peek] = await db
    .select({ executorId: taskAttempts.executorId })
    .from(taskAttempts)
    .where(eq(taskAttempts.id, attemptId));
  if (!peek) return;
  const pool = await poolOf(peek.executorId);

  // Count running attempts already in that pool.
  const running = await db
    .select({ kind: executors.kind })
    .from(taskAttempts)
    .leftJoin(executors, eq(executors.id, taskAttempts.executorId))
    .where(eq(taskAttempts.status, "running"));
  const inPool = running.filter(
    (r) => (r.kind === "cli" ? "local" : "cloud") === pool,
  ).length;
  if (inPool >= POOL_LIMITS[pool]) {
    log(`${pool} pool full (${inPool}/${POOL_LIMITS[pool]}) — ${attemptId.slice(0, 8)} stays queued`);
    return;
  }

  const [attempt] = await db
    .update(taskAttempts)
    .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
    .where(
      and(eq(taskAttempts.id, attemptId), eq(taskAttempts.status, "queued")),
    )
    .returning();
  if (!attempt) return;

  const [task] = await db
    .select()
    .from(workbenchTasks)
    .where(eq(workbenchTasks.id, attempt.taskId));
  if (!task) return;

  await setTask(task.id, { status: "running" });
  log(`attempt ${attempt.seq} of "${task.title}" → ${attempt.executorId}`);

  const [executor] = await db
    .select()
    .from(executors)
    .where(eq(executors.id, attempt.executorId));
  // Research is a read-and-write-analysis task, not an agentic one — route it to
  // the tool-free completion adapter instead of the chosen CLI agent (opencode
  // can't be stopped from re-fetching the 403'd URL or dumping to files). Code
  // executors (claude/codex) keep their own agent loop.
  const adapter =
    task.taskType === "research" && executor?.kind === "cli"
      ? researchAdapter
      : ADAPTERS[executor?.kind ?? attempt.executorId];

  // Per-attempt opencode data dir. opencode keeps a sqlite DB under
  // XDG_DATA_HOME; a run that's killed mid-write leaves it unmigratable, which
  // then breaks EVERY later run that shares it (observed). Giving each attempt
  // its own throwaway dir means a killed run can only ever poison itself — the
  // next run starts clean. Removed in `finally`.
  //
  // MUST live under the sandbox home: the seatbelt confines writes to the
  // workdir + harness home + tmp, so a dir under the real ~/.aios is blocked
  // (EPERM on opencode's mkdir) — which broke every seatboxed opencode run.
  const openDataDir = join(harnessHome("cli"), "opencode-runs", attempt.id.slice(0, 8));

  // Stall-based, not wall-clock: a run is only killed when it stops making
  // progress. As long as the executor keeps emitting events (tool calls, text,
  // steps), it may run as long as it likes — a slow local model that loads for
  // minutes and reasons for several more is working, not stuck. Only genuine
  // silence for STALL_LIMIT_MS (no event at all) counts as stuck.
  const controller = new AbortController();
  let lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs > STALL_LIMIT_MS) {
      log(
        `attempt ${attempt.id.slice(0, 8)} stuck — no progress for ${Math.round(idleMs / 60000)}min, aborting`,
      );
      controller.abort();
    }
  }, 60_000);

  try {
    if (!adapter) throw new Error(`no adapter for "${attempt.executorId}"`);

    // Hard availability gate: a CLI executor whose host binary isn't installed
    // (e.g. inside a container) must fail here — BEFORE any git worktree or
    // spawn — so it never runs and never reaches for host CLI config.
    const avail = executorAvailability(executor?.kind ?? attempt.executorId, {
      commandTemplate: executor?.commandTemplate,
      taskType: task.taskType,
    });
    if (!avail.ok) {
      throw new Error(
        `executor "${attempt.executorId}" is unavailable on this host — ${avail.reason}`,
      );
    }

    // ── isolation ──────────────────────────────────────────────────────
    // A CLI agent needs the workdir to BE the git root (a local clone), or it
    // resolves its project to the main repo through the worktree link and edits
    // the wrong tree. In-process executors (claude-headless) handle a linked
    // worktree fine, and it's cheaper, so they keep using one.
    let workdir: string;
    let branch: string | null = null;
    let baseSha: string | null = null;
    let isClone = false;
    if (executor?.gitMode === "worktree" && task.repoPath) {
      if (!(await isGitRepo(task.repoPath))) {
        throw new Error(`${task.repoPath} is not a git repository`);
      }
      isClone = executor.kind === "cli";
      const iso = isClone
        ? await createClone(task.repoPath, attempt.id)
        : await createWorktree(task.repoPath, attempt.id);
      workdir = iso.workdir;
      branch = iso.branch;
      baseSha = iso.baseSha;
      await emitEvent(attempt.id, {
        type: "status",
        payload: { phase: isClone ? "clone" : "worktree", branch, workdir },
      });
    } else {
      workdir = join(SCRATCH_ROOT, attempt.id.slice(0, 8));
      await mkdir(workdir, { recursive: true });
    }

    // The prompt on disk makes any run reproducible by hand — `cd` there and
    // re-run the same command without apOS.
    await mkdir(join(workdir, ".aios"), { recursive: true });
    await writeFile(
      join(workdir, ".aios", "task.md"),
      `# ${task.title}\n\n_type: ${task.taskType} · executor: ${attempt.executorId} · attempt ${attempt.seq}_\n\n${task.prompt}\n`,
      "utf8",
    );

    await db
      .update(taskAttempts)
      .set({ workdir, branch, baseSha })
      .where(eq(taskAttempts.id, attempt.id));

    // ── execute ────────────────────────────────────────────────────────
    // A CLI executor is driven entirely by its row: template, parser, and —
    // for opencode — the config file apOS manages instead of the user's.
    // Resolve the run model ONCE, in the namespace this executor's template
    // expects — a bare local tag gets its `ollama/` prefix for opencode so it
    // can't be misread as a (failing) cloud model.
    const runModel = normalizeModelForExecutor(
      attempt.model ?? executor?.defaultModel ?? null,
      executor?.commandTemplate,
    );
    if (executor?.kind === "cli") {
      // Free-only guarantee: a local executor may use any model from its
      // library so long as it's free. Refuse a metered spec here rather than
      // let it reach a paid API. The model was already resolved above.
      assertFreeModel(runModel);
      // Research bypasses opencode (see adapter selection), so it needs no
      // opencode config; only real opencode runs get one.
      if (task.taskType !== "research") await writeOpencodeConfig(workdir);
    }
    // Extra env/config for local agents that wire Ollama their own way
    // (Qwen Code: OPENAI_* env; Droid: a BYOK model in the sandbox
    // ~/.factory/config.json). No-op for opencode/pi.
    const localAgentEnv =
      executor?.kind === "cli"
        ? setupLocalAgent(attempt.executorId, {
            runModel,
            home: harnessHome("cli"),
          })
        : {};

    // Local models need autonomy spelled out — Claude infers it. But do NOT
    // hand them the absolute workdir path: given a clone whose project root is
    // already correct, opencode surfaces the right paths itself, and a path
    // hint just gets mangled (observed: the model turned the workdir into a
    // bogus out-of-project path and got blocked). Keep the preamble about
    // *behaviour*, not *location*.
    // A judge-triggered retry carries the critique of the previous attempt.
    // Feed it back so the retry actually closes the gaps rather than repeating
    // the same confident-but-empty output.
    const feedbackBlock = attempt.feedback
      ? [
          "",
          "A PREVIOUS ATTEMPT AT THIS TASK FELL SHORT. The verifying judge found these gaps — you MUST address them, and do NOT repeat the same mistake (no scaffolds, stubs, or 'framework in place'; produce the real deliverable):",
          attempt.feedback,
        ].join("\n")
      : "";

    // Research tasks name URLs, but the executors can't reliably fetch them
    // (many sources 403 a server fetch). Read the article(s) up front and hand
    // the text to the run — the tool-free research adapter answers straight from
    // this material. Best-effort: no material just means a leaner prompt.
    let researchBlock = "";
    if (task.taskType === "research") {
      const rc = await gatherResearchContext(task.prompt, workdir);
      researchBlock = rc.block;
      if (rc.articles > 0 || rc.knowledge > 0) {
        await emitEvent(attempt.id, {
          type: "status",
          payload: {
            phase: "fetched",
            articles: rc.articles,
            related: rc.related,
            knowledge: rc.knowledge,
          },
        });
      }
    }

    // The preamble depends on what "done" means. A research task's deliverable
    // is the analysis itself, so its material + a "write the analysis in your
    // reply" preamble; code/docs tasks keep the edit-the-files preamble.
    const cliPreamble =
      task.taskType === "research"
        ? [
            "You are a research analyst running unattended. The source material you need has already been fetched for you and is included below. Work from it plus your own knowledge.",
            "Produce your COMPLETE analysis as your final reply — the written answer IS the deliverable and is what gets graded. Don't ask questions or stop to confirm.",
            `Today is ${new Date().toISOString().slice(0, 10)}.`,
          ]
        : [
            "You are running unattended in this project directory. Read and edit files here directly, using the paths the tools give you.",
            "Do not ask questions, do not offer alternatives, do not stop to confirm — make the edits yourself, then stop.",
            // Recurring failure mode with local models: they read a 'do X on each
            // commit' task and build a git hook / script to do it later, instead
            // of doing X now. A single run can't watch future commits, and files
            // written under .git/ (hooks) aren't even tracked — so the result is
            // an empty diff and a failed run. Forbid the shortcut explicitly.
            "Do the actual work NOW by editing the target files in this directory. Do NOT create git hooks, CI workflows, or any automation to do it 'on future commits' — analyze the CURRENT state of the repo and make the concrete file edits the task names, this run. Never write into the .git/ directory.",
            `Today is ${new Date().toISOString().slice(0, 10)}.`,
          ];

    const prompt =
      executor?.kind === "cli"
        ? [...cliPreamble, "", "TASK:", task.prompt, feedbackBlock, researchBlock].join("\n")
        : task.prompt + feedbackBlock + researchBlock;

    const result = await adapter.run(
      {
        attemptId: attempt.id,
        prompt,
        workdir,
        model: runModel,
        taskType: task.taskType,
        signal: controller.signal,
        commandTemplate: executor?.commandTemplate ?? undefined,
        parser: (executor?.parser as CliParser | null) ?? undefined,
        env: {
          ...localAgentEnv,
          OPENCODE_CONFIG: AIOS_OPENCODE_CONFIG,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          // Per-attempt opencode data dir (see openDataDir above): isolated from
          // the user's global opencode AND from every other apOS run, so a
          // killed run's corrupt DB can never brick the next one.
          XDG_DATA_HOME: openDataDir,
          // Read the model DB from the local cache instead of fetching it from
          // models.dev at init — a blocking network call that intermittently
          // stalled startup. The provider SDK is pre-installed too, so opencode
          // never does an on-init `bun install` (the actual cause of the hang).
          OPENCODE_MODELS_PATH: join(
            homedir(),
            ".cache",
            "opencode",
            "models.json",
          ),
          OPENCODE_DISABLE_SHARE: "1",
          OLLAMA_HOST: "127.0.0.1:11434",
        },
        onPid: (pid) => {
          db.update(taskAttempts)
            .set({ pid })
            .where(eq(taskAttempts.id, attempt.id))
            .catch(() => {});
        },
      },
      async (e) => {
        lastProgressAt = Date.now(); // any event = progress; resets the stall clock
        await emitEvent(attempt.id, e);
        await notifyChanged(task.id);
      },
    );

    // ── settle ─────────────────────────────────────────────────────────
    let changedFiles = 0;
    let diffFiles: { path: string }[] = [];
    let diffPatch: string | null = null;
    if (branch && baseSha) {
      await commitCheckpoint(workdir, `aios: ${task.title}`.slice(0, 200));
      // A clone's branch lives in the clone; bring it into the user's repo so
      // review and merge are identical to the worktree path. The diff is then
      // read from the clone (still present), which has base..HEAD.
      if (isClone && task.repoPath) {
        await fetchBranchFromClone(task.repoPath, workdir, branch);
      }
      const diff = await diffSince(workdir, baseSha);
      changedFiles = diff.files.length;
      diffFiles = diff.files;
      diffPatch = diff.patch ?? null;
      await emitEvent(attempt.id, {
        type: "status",
        payload: { phase: "diff", files: diff.files },
      });
    }

    const timedOut = controller.signal.aborted;
    // A clean run is JUDGED whether or not it changed files. For a conditional
    // ask ("update X IF the commit affects it"), a reasoned "nothing to change"
    // is a legitimate outcome — the judge, which sees the ask, the analysis and
    // the empty diff, decides whether that's a real determination or a fizzle
    // (the old "0 files → hard fail" buried correct no-op runs as red, and a
    // lying local model is now caught by the judge instead). Only a timeout or a
    // hard executor error skips the judge.
    const executorOk = !timedOut && result.ok;
    const status = timedOut ? "timed_out" : result.ok ? "succeeded" : "failed";

    await db
      .update(taskAttempts)
      .set({
        status,
        result: result.result?.slice(0, 16000) ?? null,
        error: result.error?.slice(0, 2000) ?? null,
        exitCode: result.exitCode ?? null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        costUsd: result.costUsd != null ? String(result.costUsd) : null,
        // Record the model the executor actually ran, if it reported one and the
        // attempt didn't already pin it (claude-headless resolves it itself).
        ...(result.model && !attempt.model ? { model: result.model } : {}),
        endedAt: new Date(),
      })
      .where(eq(taskAttempts.id, attempt.id));

    if (!executorOk) {
      await setTask(task.id, {
        status: "failed",
        summary: (result.result ?? result.error ?? "").slice(0, 1000) || null,
      });
      log(`attempt ${attempt.id.slice(0, 8)} → ${status} (${changedFiles} file(s))`);
    } else {
      // ── verify (A2 · Trust): the judge gates release ──────────────────
      // A succeeded attempt has only cleared the executor's own bar. Before it
      // reaches the user as a result, a second brain checks it against the ask.
      const { judgeAttempt } = await import("./judge");
      const verdict = await judgeAttempt({
        ask: task.prompt,
        result: result.result ?? null,
        changedFiles: diffFiles.map((f) => f.path),
        patch: diffPatch,
        taskType: task.taskType,
      });
      verdict.attemptSeq = attempt.seq;
      await db
        .update(taskAttempts)
        .set({ judgeVerdict: verdict })
        .where(eq(taskAttempts.id, attempt.id));

      if (verdict.errored) {
        // The judge couldn't RUN (e.g. the routed brain hit its rate limit and
        // the local fallback also failed). That's an infra failure, not a
        // content one — the executor did its job. Don't retry (it would just hit
        // the same wall) and don't call it a fail. Release the result for the
        // user's own review, clearly marked unverified.
        await setTask(task.id, {
          status: "review",
          summary: (result.result ?? "").slice(0, 1000) || null,
          judgeStatus: "unverified",
          judgeVerdict: verdict,
        });
        log(`attempt ${attempt.id.slice(0, 8)} → judge UNAVAILABLE, released for manual review`);
      } else if (verdict.pass) {
        await setTask(task.id, {
          status: changedFiles > 0 ? "review" : "done",
          summary: (result.result ?? "").slice(0, 1000) || null,
          judgeStatus: "pass",
          judgeVerdict: verdict,
        });
        // Routine-spawned work that produced changes is delivered as a PR —
        // never a direct write. Queue it for the user's approval (A2).
        if (changedFiles > 0 && task.createdFrom?.startsWith("routines:")) {
          const { queuePrApproval } = await import("./routines");
          await queuePrApproval(task.id).catch((e) =>
            log(`queuePrApproval failed: ${e}`),
          );
        }
        log(`attempt ${attempt.id.slice(0, 8)} → PASS (${verdict.score}) released`);
      } else if (!attempt.feedback) {
        // First miss → auto-retry once, feeding the critique back so the retry
        // addresses the gaps instead of repeating them.
        const feedback = [verdict.rationale, ...verdict.gaps.map((g) => `- ${g}`)]
          .join("\n")
          .slice(0, 4000);
        const [retry] = await db
          .insert(taskAttempts)
          .values({
            taskId: task.id,
            seq: attempt.seq + 1,
            executorId: attempt.executorId,
            model: attempt.model,
            feedback,
          })
          .returning();
        await setTask(task.id, {
          status: "running",
          summary: `The judge flagged gaps — retrying once with feedback:\n${verdict.gaps
            .map((g) => `• ${g}`)
            .join("\n")}`.slice(0, 1000),
          judgeStatus: "retrying",
          judgeVerdict: verdict,
        });
        await sql.notify("workbench_run", retry.id);
        log(`attempt ${attempt.id.slice(0, 8)} → FAIL (${verdict.score}) auto-retrying`);
      } else {
        // The retry also fell short → hold it for the user (Needs-you queue).
        await setTask(task.id, {
          status: "needs_input",
          summary: `Held: the result still doesn't meet the ask after a retry.\n${verdict.rationale}\nGaps:\n${verdict.gaps
            .map((g) => `• ${g}`)
            .join("\n")}`.slice(0, 1000),
          judgeStatus: "fail",
          judgeVerdict: verdict,
        });
        log(`attempt ${attempt.id.slice(0, 8)} → FAIL (${verdict.score}) held for user`);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await emitEvent(attempt.id, { type: "error", payload: { message } });
    await db
      .update(taskAttempts)
      .set({ status: "failed", error: message.slice(0, 2000), endedAt: new Date() })
      .where(eq(taskAttempts.id, attempt.id));
    await setTask(task.id, { status: "failed", summary: message.slice(0, 500) });
    log(`attempt ${attempt.id.slice(0, 8)} failed: ${message}`);
  } finally {
    clearInterval(watchdog);
    // Discard this attempt's throwaway opencode data dir — even if the run was
    // killed, its (possibly corrupt) DB dies with it and never affects others.
    await rm(openDataDir, { recursive: true, force: true }).catch(() => {});
    await notifyChanged(task.id);
    // This attempt just freed a concurrency slot — kick the queue now instead of
    // making the next task wait for the 2-min sweep. Empty payload → reconcile,
    // which picks up the oldest queued attempt(s).
    await sql.notify("workbench_run", "").catch(() => {});
  }
}

/**
 * Restart reconciliation. A worker restart orphans its children, so any
 * attempt still marked running whose events went quiet is dead — mark it,
 * don't leave a card spinning forever.
 */
export async function reconcile(): Promise<void> {
  // A running attempt is dead only if its process is GONE (crashed / restart)
  // or it made no progress for a full hour — NOT merely because it went quiet
  // for a few minutes (a slow local model loading + reasoning is silent but
  // very much alive). This mirrors the in-run stall watchdog so the sweep can't
  // kill a run the run itself would keep.
  const running = await db
    .select()
    .from(taskAttempts)
    .where(eq(taskAttempts.status, "running"));
  const now = Date.now();
  const dead = running.filter((a) => {
    const idleMs = now - +new Date(a.heartbeatAt ?? a.startedAt ?? a.createdAt);
    if (idleMs > STALL_LIMIT_MS) return true; // stuck for an hour → dead
    // A cli attempt has a real pid: trust liveness, not the clock. An in-process
    // attempt (no pid) dies with the worker, so quiet-for-a-while means gone.
    return a.pid ? !pidAlive(a.pid) : idleMs > 5 * 60 * 1000;
  });
  for (const a of dead) {
    await db
      .update(taskAttempts)
      .set({
        status: "failed",
        error: "interrupted (worker restarted or the executor died)",
        endedAt: new Date(),
      })
      .where(eq(taskAttempts.id, a.id));
    await setTask(a.taskId, { status: "failed" });
  }
  if (dead.length) log(`reconciled ${dead.length} dead attempt(s)`);

  // Then pick up anything queued (missed NOTIFY, or freed capacity). Pull enough
  // candidates to fill both pools; runAttempt gates each by its own pool, so a
  // full local pool won't stop a cloud attempt behind it from starting.
  const queued = await db
    .select({ id: taskAttempts.id })
    .from(taskAttempts)
    .where(eq(taskAttempts.status, "queued"))
    .orderBy(asc(taskAttempts.createdAt))
    .limit(MAX_QUEUE_PICKUP);
  for (const q of queued) {
    await runAttempt(q.id).catch((e) => log(`pickup ${q.id} failed: ${e}`));
  }
}

/** Cancel a running attempt by signalling its process group. */
export async function cancelAttempt(attemptId: string): Promise<void> {
  const [attempt] = await db
    .select()
    .from(taskAttempts)
    .where(eq(taskAttempts.id, attemptId));
  if (!attempt) return;
  if (attempt.pid) {
    try {
      process.kill(-attempt.pid, "SIGTERM");
    } catch {
      // already gone — the status update below is what matters
    }
  }
  await db
    .update(taskAttempts)
    .set({ status: "cancelled", endedAt: new Date(), error: "cancelled by user" })
    .where(
      and(
        eq(taskAttempts.id, attemptId),
        inArray(taskAttempts.status, ["queued", "running"]),
      ),
    );
  await setTask(attempt.taskId, { status: "cancelled" });
}

export const workbenchJobs: ModuleJob[] = [
  {
    channel: "workbench_run",
    handle: async (payload) => {
      await ensureExecutors();
      if (payload) await runAttempt(payload);
      else await reconcile();
    },
  },
  {
    channel: "workbench_cancel",
    handle: async (payload) => {
      if (payload) await cancelAttempt(payload);
    },
  },
  {
    // Safety net: reconciliation + queued pickup, the same shape every other
    // long-running thing in apOS uses.
    channel: "workbench_sweep",
    schedule: "*/2 * * * *",
    handle: async () => {
      await ensureExecutors();
      await reconcile();
    },
  },
  {
    // "Verify free models" from Settings: live-probe the free cloud catalog
    // ($0 calls) and prune what's retired/broken. Idempotent via the health
    // ledger — a `force` payload re-checks everything.
    channel: "verify_free_models",
    handle: async (payload) => {
      const { verifyFreeModels } = await import("./models");
      const s = await verifyFreeModels({ force: payload === "force" });
      log(
        `free-model verify: ${s.ok} ok, ${s.gone} retired, ${s.error} failing, ${s.unknown} unchecked (of ${s.total})`,
      );
      await notifyChanged("free_models");
    },
  },
];
