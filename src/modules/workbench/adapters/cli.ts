/**
 * Generic CLI executor — the point of W2.
 *
 * opencode, pi and anything that comes next are *rows in the executors
 * table*, not new code paths: a command template, a parser, a timeout. The
 * engine still owns the worktree, the timeout and the process-group kill; all
 * this adapter does is substitute the template, spawn, and translate output
 * into the same normalized events every other executor emits.
 *
 * Template placeholders: {{prompt}} {{workdir}} {{model}}
 * Parsers:
 *   jsonl   — one JSON object per line (opencode `run --format json`)
 *   pi-json — pi `--mode json`
 *   text    — plain stdout, kept as text events (text-only CLIs)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Adapter, AdapterContext, AdapterEvent, AdapterResult } from "./types";
import {
  AIOS_OPENCODE_CONFIG,
  AIOS_OPENCODE_DIR,
  childPath,
  resolveBin,
} from "./opencode-env";
import { AUTO_APPROVE_FLAGS, harnessEnv, harnessHome, maybeSeatbelt } from "./sandbox";
import {
  classifyModelFailure,
  recordModelHealth,
  suggestFreeModels,
} from "../model-health";

// Re-exported for existing importers (engine.ts) — the definitions now live in
// the leaf opencode-env module to keep the model-health prober cycle-free.
export {
  AIOS_OPENCODE_CONFIG,
  AIOS_OPENCODE_DIR,
  childPath,
  resolveBin,
} from "./opencode-env";

export type CliParser = "jsonl" | "pi-json" | "text";

/**
 * Split a command template on whitespace, but keep quoted runs together and
 * substitute placeholders *after* splitting — so a prompt containing spaces
 * or quotes can never split into extra argv entries (no shell involved).
 */
export function buildArgv(
  template: string,
  vars: { prompt: string; workdir: string; model: string },
): string[] {
  const parts = template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((raw) => {
    const unquoted = /^["'].*["']$/.test(raw) ? raw.slice(1, -1) : raw;
    return unquoted
      .replaceAll("{{prompt}}", vars.prompt)
      .replaceAll("{{workdir}}", vars.workdir)
      .replaceAll("{{model}}", vars.model);
  });
}

/** opencode `run --format json` — verified against the real CLI (1.17.9). */
function parseJsonl(line: string): AdapterEvent[] {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ type: "text", payload: { text: line.slice(0, 800) } }];
  }
  const part = (o.part ?? {}) as Record<string, unknown>;
  switch (o.type) {
    case "text":
      return part.text
        ? [{ type: "text", payload: { text: String(part.text).slice(0, 16000) } }]
        : [];
    case "tool_use": {
      const state = (part.state ?? {}) as Record<string, unknown>;
      const failed = state.status === "error";
      return [
        {
          type: failed ? "error" : "tool_call",
          payload: {
            name: part.tool,
            input: JSON.stringify(state.input ?? {}).slice(0, 800),
            ...(failed ? { message: String(state.error).slice(0, 400) } : {}),
          },
        },
      ];
    }
    case "step_finish":
      return [
        {
          type: "usage",
          payload: { tokens: part.tokens, cost: part.cost },
        },
      ];
    case "step_start":
      return [{ type: "status", payload: { phase: "step" } }];
    default:
      return [];
  }
}

/** pi `--mode json` emits {type: "assistant"|"tool"|"result", ...} objects. */
function parsePiJson(line: string): AdapterEvent[] {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ type: "text", payload: { text: line.slice(0, 800) } }];
  }
  const type = String(o.type ?? "");
  if (type.includes("tool")) {
    return [
      {
        type: "tool_call",
        payload: {
          name: o.name ?? o.tool,
          input: JSON.stringify(o.input ?? o.arguments ?? {}).slice(0, 800),
        },
      },
    ];
  }
  const text = o.text ?? o.content ?? o.message;
  if (typeof text === "string" && text.trim()) {
    return [{ type: "text", payload: { text: text.slice(0, 16000) } }];
  }
  return [];
}

export const cliAdapter: Adapter = {
  id: "cli",

  async run(
    ctx: AdapterContext & {
      commandTemplate?: string;
      parser?: CliParser;
      env?: Record<string, string>;
    },
    emit,
  ): Promise<AdapterResult> {
    const template = ctx.commandTemplate;
    if (!template) return { ok: false, error: "executor has no commandTemplate" };

    const argv = buildArgv(template, {
      prompt: ctx.prompt,
      workdir: ctx.workdir,
      model: ctx.model ?? "",
    });
    const [cmd, ...args] = argv;
    const bin = resolveBin(cmd);
    if (!bin.includes("/") || !existsSync(bin)) {
      return {
        ok: false,
        error: `"${cmd}" not found — install it, or put an absolute path in the executor's command template`,
      };
    }

    const parser = ctx.parser ?? "text";
    // Subscription/local-safe env in a private HOME (harnessEnv → subscriptionEnv
    // strips metered keys; XDG dirs point at the sandbox so opencode/pi caches
    // and state stay out of the user's real config).
    const env = harnessEnv("cli", {
      ...ctx.env,
      PATH: childPath(),
      // THE root-cause fix for "opencode edits the wrong repo": the worker's
      // PWD is the apOS project, and opencode (like many tools) trusts $PWD
      // over the actual cwd to find its project root. Inheriting the stale
      // value made every run operate in the apOS checkout — it even wrote a
      // file there once. Pin PWD to the isolated workdir.
      PWD: ctx.workdir,
      CI: "1",
    });
    // Tier 2: for these auto-approve local CLIs, the OS enforces that writes
    // stay inside the workdir + sandbox home + tmp. An auto-approve CLI that
    // can't be confined (seatbelt off or unavailable) is refused, not run bare.
    const launch = maybeSeatbelt(bin, args, {
      workdir: ctx.workdir,
      home: harnessHome("cli"),
    });
    const autoApprove = args.find((a) => AUTO_APPROVE_FLAGS.includes(a));
    if (autoApprove && !launch.confined) {
      return {
        ok: false,
        error: `refusing to start "${cmd}" with ${autoApprove} outside the seatbelt (${launch.reason}) — it would approve its own writes anywhere on this machine. Re-enable the seatbelt (unset WORKBENCH_SEATBELT) or use another executor.`,
      };
    }
    const child = spawn(launch.bin, launch.args, {
      cwd: ctx.workdir,
      detached: true, // own process group, so a timeout kills its children too
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    if (child.pid) ctx.onPid?.(child.pid);

    const pending: Promise<void>[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let lastText = "";
    let stderr = "";
    let stdoutTail = ""; // raw stdout, for classifying a model-availability failure
    let buffer = "";
    let sawOutput = false;

    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      sawOutput = true;
      const events =
        parser === "jsonl"
          ? parseJsonl(line)
          : parser === "pi-json"
            ? parsePiJson(line)
            : [{ type: "text" as const, payload: { text: line.slice(0, 2000) } }];
      for (const e of events) {
        if (e.type === "text") lastText = String(e.payload.text ?? "");
        // Roll usage up into the attempt row so a local run shows the same
        // token/cost columns as a Claude one — zero cost is a result too.
        if (e.type === "usage") {
          const t = (e.payload.tokens ?? {}) as Record<string, number>;
          inputTokens += t.input ?? 0;
          outputTokens += t.output ?? 0;
          costUsd += Number(e.payload.cost ?? 0);
        }
        pending.push(emit(e));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-8000); // opencode's error JSON lands here
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) handleLine(l);
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
    if (buffer.trim()) handleLine(buffer);
    await Promise.allSettled(pending);
    ctx.signal.removeEventListener("abort", kill);

    if (ctx.signal.aborted) {
      return { ok: false, exitCode, error: "cancelled or timed out" };
    }
    // Whatever the exit code, first ask whether the *model* died on us: a
    // retired (410) or erroring free CLOUD model looks like a task failure but
    // isn't. This ONLY applies to hosted free models — a local `ollama/*` model
    // is never "retired by a provider", so a local failure (opencode crash, a
    // corrupt DB, an OOM) must NOT be blamed on the model or pull it from the
    // picker. For local models, fall through to normal error reporting.
    const isLocal = (ctx.model ?? "").startsWith("ollama/");
    const health = isLocal
      ? null
      : classifyModelFailure(`${stdoutTail}\n${stderr}`);
    if (health && ctx.model) {
      recordModelHealth(ctx.model, health.status, health.detail);
      const alt = suggestFreeModels();
      const why =
        health.status === "gone"
          ? "is no longer available — the provider retired it"
          : "is failing on the provider right now";
      return {
        ok: false,
        exitCode,
        error:
          `"${ctx.model}" ${why}. It's been removed from your free-model list; ` +
          (alt.length ? `try a known-good free model instead: ${alt.join(", ")}.` : "pick another free model."),
      };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        exitCode,
        error: stderr.trim().slice(-800) || `exit ${exitCode}`,
      };
    }
    // A clean exit that produced nothing is a failure, not a success: it means
    // the agent hung or refused, and reporting "done" would be a lie.
    if (!sawOutput) {
      return {
        ok: false,
        exitCode,
        error: `${cmd} exited 0 without producing any output${stderr.trim() ? ` — stderr: ${stderr.trim().slice(-400)}` : ""}`,
      };
    }
    // A real result means this model works — remember that too, so a prior
    // transient error doesn't keep it hidden.
    recordModelHealth(ctx.model, "ok");
    return {
      ok: true,
      exitCode,
      result: lastText.slice(0, 16000),
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      costUsd,
    };
  },
};
