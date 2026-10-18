/**
 * Harness isolation (Tier 1 + Tier 2).
 *
 * Every Workbench CLI harness used to run under the user's real `$HOME`, so a
 * delegated run read AND wrote the user's global `~/.claude`, `~/.codex`,
 * opencode caches, etc. (claude-headless even had a bespoke hack to scrub the
 * auto-memory it left in `~/.claude/projects`). This module gives each harness
 * a private, writable HOME under `~/.aios/harness-home/<kind>` while keeping it
 * working exactly as before:
 *
 *   • Tier 1 — isolated HOME. The run's writes (session history, auto-memory,
 *     caches, sqlite state) land in the sandbox home and never touch the real
 *     one. The config/auth the harness needs to behave as today is linked in
 *     read-through: for Claude we mirror all of `~/.claude` EXCEPT the known
 *     write-pollution dirs; for Codex/opencode we link the specific auth+config
 *     entries. Auth still works — the Claude token authenticates from the env
 *     even in an isolated HOME (see core/ai/auth.ts), Codex reads the linked
 *     `auth.json`. `~/.gitconfig`/`~/.npmrc` are linked so in-run git/npm keep
 *     the user's identity; `~/.ssh` is deliberately NOT linked (a delegated
 *     agent shouldn't hold your keys — pushes are the engine's job anyway).
 *
 *   • Tier 2 — a macOS seatbelt (`sandbox-exec`) profile for the auto-approve
 *     local CLIs (opencode/pi), enforced by the OS: writes are confined to the
 *     workdir + sandbox home + tmp, reads/exec/network stay open so runs behave
 *     normally. Toggle off with `WORKBENCH_SEATBELT=off` if a run needs it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { subscriptionEnv } from "@/core/ai/auth";

export type HarnessKind = "claude" | "codex" | "cli";

const HOME_ROOT = join(homedir(), ".aios", "harness-home");

/** Real `~/.claude` entries that are pure RUN OUTPUT — isolate, never share. */
const CLAUDE_WRITE_DENY = new Set([
  "projects", // per-project session history + auto-memory (the old scrub hack)
  "sessions",
  "history.jsonl",
  "shell-snapshots",
  "session-env",
  "todos",
  "tasks",
  "jobs",
  "statsig",
  "cache",
  "paste-cache",
  "downloads",
  "backups",
  ".DS_Store",
  ".last-cleanup",
  ".last-update-result.json",
]);

/** Codex/opencode need very little — link exactly that, isolate the rest. */
const CODEX_LINK = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "skills",
  "plugins",
  "packages",
  "models_cache.json",
];

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** Symlink `real` → `dest` once; skip if the source is missing or dest exists. */
function link(real: string, dest: string): void {
  if (!existsSync(real)) return;
  try {
    lstatSync(dest);
    return; // already seeded (idempotent)
  } catch {
    /* not there yet */
  }
  try {
    ensureDir(dirname(dest));
    symlinkSync(real, dest);
  } catch {
    /* best-effort: a missing link just means the harness falls back to defaults */
  }
}

/** Mirror each entry of `realDir` into `destDir` by symlink, minus a denylist. */
function mirrorExcept(realDir: string, destDir: string, deny: Set<string>): void {
  if (!existsSync(realDir)) return;
  ensureDir(destDir);
  for (const name of readdirSync(realDir)) {
    if (deny.has(name)) continue;
    link(join(realDir, name), join(destDir, name));
  }
}

/** Seed the sandbox home so the harness behaves as it does under the real home. */
function seed(kind: HarnessKind, home: string): void {
  ensureDir(home);
  // Shared: keep git/npm identity + registry config so in-run tooling works.
  link(join(homedir(), ".gitconfig"), join(home, ".gitconfig"));
  link(join(homedir(), ".npmrc"), join(home, ".npmrc"));

  if (kind === "claude") {
    mirrorExcept(join(homedir(), ".claude"), join(home, ".claude"), CLAUDE_WRITE_DENY);
    // NOTE: ~/.claude.json (project history/MCP state) is intentionally NOT
    // linked — it's write-heavy pollution; a fresh one in the sandbox is fine.
  } else if (kind === "codex") {
    const realCodex = join(homedir(), ".codex");
    const destCodex = join(home, ".codex");
    ensureDir(destCodex);
    for (const entry of CODEX_LINK) link(join(realCodex, entry), join(destCodex, entry));
  } else {
    // cli (opencode/pi): config/auth via XDG (see harnessEnv) — link the config
    // + data dirs the tools read; caches/state fall through to the sandbox.
    const cfg = join(home, ".config");
    const data = join(home, ".local", "share");
    ensureDir(cfg);
    ensureDir(data);
    for (const app of ["opencode", "pi"]) {
      link(join(homedir(), ".config", app), join(cfg, app));
      link(join(homedir(), ".local", "share", app), join(data, app));
    }
  }
}

/**
 * Environment for a spawned harness: subscription-safe (metered keys stripped),
 * pointed at a private HOME (and, for cli, XDG dirs) seeded to behave as today.
 * `extra` is merged last so callers can still set PWD/PATH/CI.
 */
export function harnessEnv(
  kind: HarnessKind,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const home = join(HOME_ROOT, kind);
  seed(kind, home);
  const xdg =
    kind === "cli"
      ? {
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_STATE_HOME: join(home, ".local", "state"),
        }
      : {};
  return subscriptionEnv({ HOME: home, ...xdg, ...extra });
}

/** The private HOME path for a harness kind (already created by harnessEnv). */
export function harnessHome(kind: HarnessKind): string {
  return join(HOME_ROOT, kind);
}

// ── Tier 2: macOS seatbelt for the auto-approve local CLIs ───────────────────

// Allow everything (reads, exec, network) but confine FILE WRITES to the
// workdir, the sandbox home, and tmp — so an over-eager local agent can't edit
// anything outside its task. Paths come in as `-D` params (no string interp).
const SEATBELT_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath (param "WORKDIR"))
  (subpath (param "HOMEDIR"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/private/var/tmp")
  (literal "/dev/null") (literal "/dev/zero")
  (literal "/dev/random") (literal "/dev/urandom")
  (regex #"^/dev/tty") (regex #"^/dev/fd/"))`;

const seatbeltDisabled = (): boolean =>
  /^(0|off|false|no)$/i.test(process.env.WORKBENCH_SEATBELT ?? "");

/**
 * Wrap a command in `sandbox-exec` (write-confinement) when it's a local CLI on
 * macOS and seatbelt isn't disabled. Falls back to the bare command otherwise,
 * with `confined: false` and why — the caller decides whether that's acceptable
 * (it isn't for an auto-approve CLI, see AUTO_APPROVE_FLAGS).
 */
export function maybeSeatbelt(
  bin: string,
  args: string[],
  opts: { workdir: string; home: string },
): { bin: string; args: string[]; confined: boolean; reason?: string } {
  if (process.platform !== "darwin")
    return { bin, args, confined: false, reason: "seatbelt is macOS-only" };
  if (seatbeltDisabled())
    return { bin, args, confined: false, reason: "WORKBENCH_SEATBELT is off" };
  if (!existsSync("/usr/bin/sandbox-exec"))
    return { bin, args, confined: false, reason: "/usr/bin/sandbox-exec not found" };
  try {
    const workdir = realpathSync(opts.workdir);
    const home = realpathSync(opts.home);
    return {
      bin: "/usr/bin/sandbox-exec",
      args: ["-p", SEATBELT_PROFILE, "-D", `WORKDIR=${workdir}`, "-D", `HOMEDIR=${home}`, bin, ...args],
      confined: true,
    };
  } catch {
    return { bin, args, confined: false, reason: "couldn't resolve the sandbox paths" };
  }
}

/** CLI flags that make an agent approve its own writes and shell commands. Such
 *  a CLI only runs inside the seatbelt — that's the one thing keeping its
 *  writes in the workdir; opencode's permission config doesn't confine bash. */
export const AUTO_APPROVE_FLAGS = [
  "--dangerously-skip-permissions",
  "--skip-permissions-unsafe",
  "--yolo",
  "-y", // qwen's short --yolo
];
