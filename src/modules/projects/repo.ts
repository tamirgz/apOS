// Code grounding: keep a read-only clone of a project's repo so agents can read
// the real code. EVERY attached repo — remote GitHub URL *and* local folder —
// is copied to ~/.aios/repos/<projectId>, and apOS only ever reads/operates on
// that copy. A local folder is copied with `git clone --no-hardlinks --local`
// (a fully independent object store), so apOS can never write your original
// repo or its origin: the source is only ever read (clone/fetch), never pushed.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const REPOS_ROOT = join(homedir(), ".aios", "repos");

// Never let git block on a credential prompt in the non-interactive worker.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export function projectRepoDir(projectId: string): string {
  return join(REPOS_ROOT, projectId);
}

/** A git remote vs. a local absolute path. */
export function isLocalPath(ref: string): boolean {
  return ref.startsWith("/") || ref.startsWith("~");
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * The directory an agent should read for this project, or null. Always the
 * read-only cache copy (never the user's original) — both remote and local
 * repos are copied there by syncProjectRepo.
 */
export function usableRepoPath(
  projectId: string,
  repoUrl: string | null,
): string | null {
  if (!repoUrl?.trim()) return null;
  const dir = projectRepoDir(projectId);
  return existsSync(join(dir, ".git")) ? dir : null;
}

export interface RepoSyncResult {
  ok: boolean;
  path?: string;
  detail: string;
}

const run = (args: string[]) =>
  exec("git", args, { env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });

/**
 * Point the copy at the source's main line — main, else master, else whatever
 * the source has checked out. A clone otherwise inherits the branch the source
 * happened to be on when it was attached and follows it forever, so the copy
 * silently froze on an old feature branch.
 */
async function followMainLine(dir: string): Promise<string> {
  let branch: string | null = null;
  for (const b of ["main", "master"]) {
    try {
      await run(["-C", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]);
      branch = b;
      break;
    } catch {
      /* not on this source */
    }
  }
  if (!branch) {
    await run(["-C", dir, "remote", "set-head", "origin", "--auto"]);
    const { stdout } = await run(["-C", dir, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
    branch = stdout.trim().replace(/^origin\//, "");
  }
  // -f -B: the copy is read-only, so local state is always disposable.
  await run(["-C", dir, "checkout", "-f", "-B", branch, `origin/${branch}`]);
  return branch;
}

/**
 * Clone (first time) or refresh the project's read-only cache copy. A changed
 * source (the user re-pointed the project) is re-cloned — fetching would keep
 * mirroring the old repo. Public remotes work as-is; a private remote fails
 * cleanly (no prompt) — it needs a token in the URL.
 */
export async function syncProjectRepo(
  projectId: string,
  repoUrl: string,
): Promise<RepoSyncResult> {
  const ref = repoUrl.trim();
  if (!ref) return { ok: false, detail: "no repo url" };

  const local = isLocalPath(ref);
  const source = local ? expandHome(ref) : ref;
  if (local && !existsSync(join(source, ".git"))) {
    return { ok: false, detail: `local path is not a git repo: ${source}` };
  }

  const dir = projectRepoDir(projectId);
  try {
    let detail = local ? "copied (read-only)" : "cloned";
    if (existsSync(join(dir, ".git"))) {
      const { stdout } = await run(["-C", dir, "remote", "get-url", "origin"]).catch(() => ({ stdout: "" }));
      const norm = (u: string) => u.trim().replace(/\/+$/, "");
      if (norm(stdout) === norm(source)) {
        // `fetch` only READS the source; we never push, so the original is safe.
        // --prune drops branches deleted at the source.
        await run(["-C", dir, "fetch", "--prune", "origin"]);
        const branch = await followMainLine(dir);
        return { ok: true, path: dir, detail: `updated (${branch})` };
      }
      await rm(dir, { recursive: true, force: true });
      detail = "re-cloned (repo changed)";
    }
    await mkdir(REPOS_ROOT, { recursive: true });
    // --no-hardlinks --local for a local source = a fully independent copy, so
    // nothing apOS does to the copy can ever reach the user's original repo.
    await run(local ? ["clone", "--no-hardlinks", "--local", source, dir] : ["clone", source, dir]);
    const branch = await followMainLine(dir);
    return { ok: true, path: dir, detail: `${detail} (${branch})` };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
    return { ok: false, detail: msg.slice(0, 300) };
  }
}
