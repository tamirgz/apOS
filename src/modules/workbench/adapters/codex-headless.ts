/**
 * OpenAI Codex CLI in non-interactive mode — GPT-5 via a ChatGPT Pro
 * subscription, no API key. The OpenAI analogue of claude-headless: auth is
 * `codex login` ("Sign in with ChatGPT") → ~/.codex/auth.json, and
 * subscriptionEnv strips OPENAI_API_KEY so a stray key can never silently flip
 * this run to per-token API billing (Codex's documented footgun).
 *
 * `codex exec --json` streams JSONL, verified against codex-cli 0.147.0:
 *   {"type":"thread.started","thread_id":…}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":…}}   ← answer
 *   {"type":"item.completed","item":{"type":"reasoning"|"command_execution"|
 *                                    "file_change"|"mcp_tool_call"|"web_search"…}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
 *   {"type":"error"|"turn.failed", …}
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { childPath, resolveBin } from "./opencode-env";
import { codexMcpArgs } from "./apos-mcp";
import { harnessEnv } from "./sandbox";
import type { Adapter, AdapterContext, AdapterEvent, AdapterResult } from "./types";

/** Research/docs read, coding tasks may write their worktree. */
function sandboxFor(taskType: string): "read-only" | "workspace-write" {
  return taskType === "research" || taskType === "docs"
    ? "read-only"
    : "workspace-write";
}

function truncate(value: unknown, max = 1200): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return s.length > max ? `${s.slice(0, max)}… [${s.length} chars]` : s;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  name?: string;
}
interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: unknown;
  message?: string;
}

function translate(line: CodexLine): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  switch (line.type) {
    case "thread.started":
      out.push({
        type: "status",
        payload: { phase: "started", session: line.thread_id },
      });
      break;
    case "item.completed": {
      const it = line.item ?? {};
      if (it.type === "agent_message" && it.text?.trim()) {
        out.push({ type: "text", payload: { text: it.text } });
      } else if (it.type === "reasoning" && it.text?.trim()) {
        out.push({ type: "summary", payload: { text: truncate(it.text, 400) } });
      } else if (it.type === "command_execution") {
        out.push({
          type: "tool_call",
          payload: { name: "shell", input: truncate(it.command ?? it.text) },
        });
      } else if (it.type === "file_change") {
        out.push({ type: "status", payload: { phase: "edit" } });
      } else if (it.type === "mcp_tool_call" || it.type === "web_search") {
        out.push({
          type: "tool_call",
          payload: { name: it.type, input: truncate(it) },
        });
      }
      break;
    }
    case "error":
    case "turn.failed":
      out.push({
        type: "error",
        payload: {
          message: String(line.error ?? line.message ?? "codex error").slice(0, 400),
        },
      });
      break;
  }
  return out;
}

export const codexHeadlessAdapter: Adapter = {
  id: "codex-headless",

  async run(ctx: AdapterContext, emit): Promise<AdapterResult> {
    const bin = resolveBin("codex");
    if (!bin.includes("/") || !existsSync(bin)) {
      return {
        ok: false,
        error:
          "codex CLI not found — install it and run `codex login` (Sign in with ChatGPT), and make sure it's on PATH",
      };
    }

    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check", // research runs in a scratch dir, not a repo
      "-s",
      sandboxFor(ctx.taskType),
      "-C",
      ctx.workdir,
      // The apOS work tracker as MCP tools, declared for this run only.
      ...codexMcpArgs("workbench-codex"),
    ];
    if (ctx.model) args.push("-m", ctx.model);
    args.push(ctx.prompt);

    const child = spawn(bin, args, {
      cwd: ctx.workdir,
      detached: true, // own process group so a timeout kills the CLI + children
      stdio: ["ignore", "pipe", "pipe"],
      // Subscription auth only (harnessEnv → subscriptionEnv strips OPENAI_API_KEY
      // et al., so this can never fall through to metered billing) AND an isolated
      // HOME so the run reads the linked auth.json/config.toml but writes its
      // session state into ~/.aios/harness-home/codex, not your real ~/.codex.
      // PATH is widened because launchd hands the worker a minimal one.
      env: harnessEnv("codex", {
        CI: "1",
        PWD: ctx.workdir,
        PATH: childPath(),
      }),
    });
    if (child.pid) ctx.onPid?.(child.pid);

    let stderr = "";
    let stdoutTail = "";
    let buffer = "";
    let lastText = "";
    let inTok = 0;
    let outTok = 0;
    let errorMsg = "";
    const ranModel = ctx.model ?? null;
    const pending: Promise<void>[] = [];

    const onLine = (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      let parsed: CodexLine;
      try {
        parsed = JSON.parse(text) as CodexLine;
      } catch {
        pending.push(emit({ type: "text", payload: { text: truncate(text) } }));
        return;
      }
      for (const e of translate(parsed)) pending.push(emit(e));
      if (
        parsed.type === "item.completed" &&
        parsed.item?.type === "agent_message" &&
        parsed.item.text
      ) {
        lastText = parsed.item.text; // the final one wins
      }
      if (parsed.type === "turn.completed" && parsed.usage) {
        inTok += parsed.usage.input_tokens ?? 0;
        outTok += parsed.usage.output_tokens ?? 0;
      }
      if (parsed.type === "error" || parsed.type === "turn.failed") {
        errorMsg = String(parsed.error ?? parsed.message ?? "codex error");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-8000);
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-8000);
    });

    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 10_000).unref();
    };
    ctx.signal.addEventListener("abort", kill, { once: true });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("error", (e) => {
        stderr += `\nspawn error: ${e.message}`;
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
    if (buffer.trim()) onLine(buffer);
    await Promise.allSettled(pending);
    ctx.signal.removeEventListener("abort", kill);

    const usage = {
      inputTokens: inTok || undefined,
      outputTokens: outTok || undefined,
      // Covered by the ChatGPT subscription — no per-run dollar cost.
      costUsd: 0,
      model: ranModel,
    };

    if (ctx.signal.aborted) {
      return { ok: false, exitCode, error: "cancelled or timed out", ...usage };
    }
    if (errorMsg) {
      return { ok: false, exitCode, error: errorMsg.slice(0, 800), ...usage };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        exitCode,
        error: stderr.trim().slice(-800) || `exit ${exitCode}`,
        ...usage,
      };
    }
    if (!lastText.trim()) {
      return {
        ok: false,
        exitCode,
        error: `codex produced no final message${stderr.trim() ? ` — ${stderr.trim().slice(-300)}` : ""}`,
        ...usage,
      };
    }
    return { ok: true, exitCode, result: lastText.slice(0, 8000), ...usage };
  },
};
