/**
 * Claude Code in headless mode — the heavyweight executor: repo work and
 * research that needs judgment plus the web.
 *
 * Contract verified against the real CLI (v2.1.210) rather than from memory;
 * `claude -p --output-format stream-json --verbose` emits one JSON object per
 * line: system/init, assistant (content blocks), user (tool_result),
 * system/post_turn_summary (a ready-made headline) and a final `result`
 * carrying num_turns, usage and total_cost_usd.
 *
 * Auth is the Max subscription via ~/.claude — no API key is passed.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeMcpArgs } from "./apos-mcp";
import { harnessEnv } from "./sandbox";
import type { Adapter, AdapterContext, AdapterEvent, AdapterResult } from "./types";

/** Tools per task type — a research task has no business editing the repo. */
const ALLOWED_TOOLS: Record<string, string[]> = {
  research: ["WebSearch", "WebFetch", "Read", "Write", "Glob", "Grep"],
  code: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"],
  docs: ["Read", "Write", "Edit", "Glob", "Grep"],
  custom: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
};

/**
 * launchd gives the worker a minimal PATH, so `claude` is usually not on it.
 * Resolve the binary explicitly instead of failing with ENOENT at spawn.
 */
export function resolveClaudeBin(): string {
  if (process.env.WORKBENCH_CLAUDE_BIN) return process.env.WORKBENCH_CLAUDE_BIN;
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((p) => existsSync(p)) ?? "claude";
}

interface StreamLine {
  type?: string;
  subtype?: string;
  message?: { content?: Record<string, unknown>[] };
  status_detail?: string;
  status_category?: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  model?: string;
  terminal_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function translate(line: StreamLine): AdapterEvent[] {
  const out: AdapterEvent[] = [];

  if (line.type === "system" && line.subtype === "init") {
    out.push({
      type: "status",
      payload: { phase: "started", model: line.model, session: line.session_id },
    });
  }

  if (line.type === "system" && line.subtype === "post_turn_summary") {
    // The CLI's own one-line summary — exactly the headline the card needs.
    out.push({
      type: "summary",
      payload: { text: line.status_detail, category: line.status_category },
    });
  }

  for (const block of line.message?.content ?? []) {
    const b = block as {
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
    };
    if (b.type === "text" && b.text?.trim()) {
      out.push({ type: "text", payload: { text: b.text } });
    } else if (b.type === "tool_use") {
      out.push({
        type: "tool_call",
        payload: { name: b.name, input: truncate(b.input) },
      });
    } else if (b.type === "tool_result") {
      out.push({
        type: "tool_result",
        payload: { result: truncate(b.content) },
      });
    }
  }

  if (line.type === "result") {
    out.push({
      type: "result",
      payload: {
        text: line.result,
        isError: line.is_error,
        turns: line.num_turns,
        costUsd: line.total_cost_usd,
        terminalReason: line.terminal_reason,
      },
    });
  }

  return out;
}

/** Tool payloads can be whole files — keep the event log readable. */
function truncate(value: unknown, max = 1200): unknown {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}… [${s.length} chars]` : s;
}

export const claudeHeadlessAdapter: Adapter = {
  id: "claude-headless",

  async run(ctx: AdapterContext, emit): Promise<AdapterResult> {
    const bin = resolveClaudeBin();
    // The apOS work tracker as MCP tools — comment progress, file follow-ups.
    const apos = claudeMcpArgs("workbench-claude");
    const args = [
      "-p",
      ctx.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Edits are the point of a delegated task; the git worktree is the
      // safety net, and merging stays a human act.
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...(ALLOWED_TOOLS[ctx.taskType] ?? ALLOWED_TOOLS.custom),
      ...apos.allowed,
      "--max-turns",
      "60",
      ...apos.args,
    ];
    if (ctx.model) args.push("--model", ctx.model);

    const child = spawn(bin, args, {
      cwd: ctx.workdir,
      // Own process group: a timeout must kill the CLI *and* its children
      // (bash, git, node) — signalling only the parent leaves orphans.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Subscription auth only (an inherited API key would silently switch this
      // run from the Max plan to per-token billing) AND an isolated HOME: the
      // run reads the user's real config (skills/settings/hooks are linked in)
      // but writes session history + auto-memory into ~/.aios/harness-home/claude
      // instead of the real ~/.claude — so the auto-memory scrub below is now
      // belt-and-suspenders. PWD is pinned to the worktree so a tool that trusts
      // $PWD over cwd can't resolve back to the apOS project.
      env: harnessEnv("claude", { CI: "1", PWD: ctx.workdir }),
    });
    if (child.pid) ctx.onPid?.(child.pid);

    let stderr = "";
    let final: AdapterResult = { ok: false, error: "no result event" };
    let ranModel: string | null = ctx.model ?? null;
    let buffer = "";
    const pending: Promise<void>[] = [];

    // Sandbox Claude Code's auto-memory: on a delegated run it writes task
    // notes into ~/.claude/projects/<project>/memory, polluting the user's
    // real memory store. `--bare` would disable it but forces ANTHROPIC_API_KEY
    // (never reads OAuth), which breaks subscription auth — and there's no
    // granular flag. So snapshot that dir from the init event's reported path
    // and remove whatever the run adds. See the `init` handler below.
    let memDir: string | null = null;
    let memPre: Set<string> | null = null;
    let memDirExisted = false;
    const cleanupMemory = () => {
      if (!memDir || !memPre) return;
      try {
        if (!memDirExisted) {
          rmSync(memDir, { recursive: true, force: true });
          return;
        }
        for (const entry of readdirSync(memDir)) {
          if (!memPre.has(entry)) {
            rmSync(join(memDir, entry), { recursive: true, force: true });
          }
        }
        // Claude scaffolds an empty memory/ dir at startup even when it writes
        // nothing; if we didn't have one and it's empty, drop the shell too.
        if (memPre.size === 0 && readdirSync(memDir).length === 0) {
          rmSync(memDir, { recursive: true, force: true });
        }
      } catch {
        // best-effort — never fail a run over memory cleanup
      }
    };

    const onLine = (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      let parsed: StreamLine;
      try {
        parsed = JSON.parse(text) as StreamLine;
      } catch {
        // Non-JSON noise on stdout (rare) is still worth keeping.
        pending.push(emit({ type: "text", payload: { text: truncate(text) } }));
        return;
      }
      // The init line is authoritative for the model Claude Code resolved and
      // for the auto-memory path (which we snapshot to clean up afterward).
      if (parsed.type === "system" && parsed.subtype === "init") {
        if (parsed.model) ranModel = parsed.model;
        const auto = (parsed as { memory_paths?: { auto?: string } }).memory_paths
          ?.auto;
        if (auto && !memDir) {
          memDir = auto;
          memDirExisted = existsSync(auto);
          memPre = memDirExisted ? new Set(readdirSync(auto)) : new Set();
        }
      }
      for (const e of translate(parsed)) pending.push(emit(e));
      if (parsed.type === "result") {
        const u = parsed.usage ?? {};
        final = {
          ok: parsed.is_error !== true,
          result: parsed.result,
          error: parsed.is_error ? (parsed.result ?? "executor error") : undefined,
          // Cache reads/creations are what the context actually cost.
          inputTokens:
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: parsed.total_cost_usd,
          model: ranModel,
        };
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
        // Grace, then insist.
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }, 10_000).unref();
      }
    };
    ctx.signal.addEventListener("abort", kill, { once: true });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("error", (e) => {
        final = { ok: false, error: `spawn failed: ${e.message}` };
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
    if (buffer.trim()) onLine(buffer);
    await Promise.allSettled(pending);
    ctx.signal.removeEventListener("abort", kill);
    // Undo any auto-memory the run left in the user's ~/.claude store.
    cleanupMemory();

    if (ctx.signal.aborted) {
      return { ...final, ok: false, exitCode, error: "cancelled or timed out" };
    }
    // 143 = SIGTERM; the CLI exits cleanly on it, which is why cancel is safe.
    if (exitCode !== 0 && final.ok) {
      return {
        ...final,
        ok: false,
        exitCode,
        error: stderr.trim().slice(-800) || `exit ${exitCode}`,
      };
    }
    return { ...final, exitCode };
  },
};
