/**
 * Commit ↔ work-item linking. Scans each attached repo's read-only cache clone
 * (kept fresh by project_repos_sync) for identifiers like ETHOS-12 in commit
 * messages:
 *   - any mention            → a "commit" link on the item
 *   - "fixes / closes / resolves ETHOS-12" → the item is closed (done)
 *
 * Ledger: projects.work_link_sha = the last HEAD scanned, advanced by
 * compare-and-swap so concurrent sweeps can't double-process a range. The
 * first scan of a repo links recent history but never closes anything.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { projects } from "@/modules/projects/schema";
import { usableRepoPath } from "@/modules/projects/repo";
import { addComment, addLink, findByIdentifier, updateWorkItem } from "./core";
import { IDENTIFIER_RE, LOOSE_KEY } from "./keys";
import { isClosed } from "./schema";

const exec = promisify(execFile);

export interface Commit {
  sha: string;
  author: string;
  subject: string;
  body: string;
}

const CLOSE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+((?:[A-Z]{1,5}-\d{1,6}(?:\s*(?:,|and|&)\s*)?)+)/gi;

/** Every identifier a message mentions, and which of them it closes. */
export function scanMessage(message: string): { mentions: string[]; closes: string[] } {
  const mentions = [...new Set([...message.matchAll(IDENTIFIER_RE)].map((m) => `${m[1]}-${Number(m[2])}`))]
    // "T-4" is the loose-item key but also far too common in prose ("T-1000", "COVID-19"-ish noise).
    .filter((id) => !id.startsWith(`${LOOSE_KEY}-`));
  const closes = new Set<string>();
  for (const m of message.matchAll(CLOSE_RE)) {
    for (const id of m[1].toUpperCase().matchAll(IDENTIFIER_RE)) closes.add(`${id[1]}-${Number(id[2])}`);
  }
  return { mentions, closes: mentions.filter((id) => closes.has(id)) };
}

const SEP_FIELD = "\x1f";
const SEP_REC = "\x1e";

export function parseLog(out: string): Commit[] {
  return out
    .split(SEP_REC)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, author, subject, body] = r.split(SEP_FIELD);
      return { sha, author, subject: subject ?? "", body: (body ?? "").trim() };
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}

async function gitLog(dir: string, range: string[]): Promise<Commit[]> {
  const { stdout } = await exec(
    "git",
    ["-C", dir, "log", "--no-merges", `--format=%H${SEP_FIELD}%an${SEP_FIELD}%s${SEP_FIELD}%b${SEP_REC}`, ...range],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return parseLog(stdout);
}

async function headOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A browsable commit URL for GitHub-style remotes; null for local-path repos. */
export function commitUrl(repoUrl: string | null, sha: string): string | null {
  const m = repoUrl?.trim().match(/^(?:https?:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  if (!m || repoUrl!.startsWith("/") || repoUrl!.startsWith("~")) return null;
  return `https://${m[1]}/${m[2].replace(/^[^@]+@/, "")}/commit/${sha}`;
}

export interface LinkResult {
  linked: number;
  closed: number;
}

/** Apply one batch of commits. `allowClose` is false for the baseline scan. */
export async function applyCommits(
  db: Db,
  commits: Commit[],
  opts: { repoUrl: string | null; allowClose: boolean },
): Promise<LinkResult> {
  let linked = 0;
  let closed = 0;
  // Oldest first, so a "reopen then fix again" sequence ends in the right state.
  for (const c of [...commits].reverse()) {
    const { mentions, closes } = scanMessage(`${c.subject}\n${c.body}`);
    for (const identifier of mentions) {
      const item = await findByIdentifier(db, identifier);
      if (!item) continue;
      const short = c.sha.slice(0, 7);
      const row = await addLink(db, item.id, {
        kind: "commit",
        ref: c.sha,
        title: c.subject.slice(0, 200),
        url: commitUrl(opts.repoUrl, c.sha),
      });
      if (!row) continue; // already linked — never re-close on a rescan
      linked++;
      if (opts.allowClose && closes.includes(identifier) && !isClosed(item.status)) {
        await updateWorkItem(db, item.id, { status: "done" }, "system:commit");
        await addComment(db, item.id, `Closed by commit ${short} (${c.author}): ${c.subject}`, "system:commit");
        closed++;
      }
    }
  }
  return { linked, closed };
}

/** Sweep every project with an attached repo. Idempotent per commit. */
export async function linkCommits(db: Db): Promise<LinkResult & { repos: number }> {
  const rows = await db
    .select({ id: projects.id, repoUrl: projects.repoUrl, ledger: projects.workLinkSha })
    .from(projects)
    .where(isNotNull(projects.repoUrl));
  const total = { linked: 0, closed: 0, repos: 0 };
  for (const p of rows) {
    const dir = usableRepoPath(p.id, p.repoUrl);
    if (!dir) continue;
    const head = await headOf(dir);
    if (!head || head === p.ledger) continue;

    // Claim the range first (CAS on the ledger we observed).
    const claimed = await db
      .update(projects)
      .set({ workLinkSha: head })
      .where(and(eq(projects.id, p.id), p.ledger ? eq(projects.workLinkSha, p.ledger) : isNull(projects.workLinkSha)))
      .returning({ id: projects.id });
    if (!claimed.length) continue;
    total.repos++;

    let commits: Commit[];
    let allowClose = true;
    if (!p.ledger) {
      commits = await gitLog(dir, ["-n", "300", head]);
      allowClose = false;
    } else {
      // A rewritten history (force-push) loses the old sha — fall back to a
      // link-only look at recent commits rather than guessing.
      commits = await gitLog(dir, ["-n", "500", `${p.ledger}..${head}`]).catch(async () => {
        allowClose = false;
        return gitLog(dir, ["-n", "50", head]);
      });
    }
    const r = await applyCommits(db, commits, { repoUrl: p.repoUrl, allowClose });
    total.linked += r.linked;
    total.closed += r.closed;
  }
  return total;
}
