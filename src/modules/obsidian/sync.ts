import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { notInArray, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import type { ModuleJob } from "@/core/modules/types.server";
import { obsidianNotes } from "./schema";

export const OBSIDIAN_PATH_KEY = "obsidian_vault_path";
const ACTIVE_PATH_KEY = "obsidian_vault_path_active";
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const MAX_FILE_BYTES = 200_000;

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push(join(dir, entry.name));
        }
      } else if (entry.name.endsWith(".md")) {
        out.push(join(dir, entry.name));
      }
    }
  }
  return out;
}

function extractTitle(content: string, fallback: string): string {
  const fm = content.match(/^---\n[\s\S]*?\btitle:\s*["']?([^"'\n]+)/);
  if (fm) return fm[1].trim();
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

function toExcerpt(content: string): string {
  return content
    .replace(/^---\n[\s\S]*?\n---\n/, "") // frontmatter
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

/**
 * Incremental read-only sync: upsert changed .md files, remove deleted ones,
 * wipe the index when the vault path setting changes. Embeddings are filled
 * by the worker's embedding sweep.
 */
export async function syncVault(
  log: (m: string) => void = () => {},
  opts: { notifyOnError?: boolean } = {},
): Promise<{ indexed: number; removed: number } | null> {
  // Defensive: strip pasted shell quotes even if an old value predates the
  // save-time normalization.
  const root = (await getSetting(OBSIDIAN_PATH_KEY))
    ?.trim()
    .replace(/^['"]+/, "")
    .replace(/['"]+$/, "");
  if (!root) return null;

  try {
    await stat(root);
  } catch {
    log(`obsidian vault path does not exist: ${root}`);
    if (opts.notifyOnError) {
      const { notify } = await import("@/core/notify");
      await notify({
        title: "Vault sync failed",
        body: `The configured vault path does not exist or is not readable:\n${root}`,
        level: "warn",
        source: "vault",
        href: "/m/settings/connections",
      });
    }
    return null;
  }

  // Path changed since last sync → drop the old index entirely.
  const active = await getSetting(ACTIVE_PATH_KEY);
  if (active && active !== root) {
    await db.delete(obsidianNotes);
    log(`vault path changed — index wiped`);
  }
  await setSetting(ACTIVE_PATH_KEY, root);

  const files = await walkMarkdown(root);
  const existing = await db
    .select({
      path: obsidianNotes.path,
      mtime: obsidianNotes.mtime,
    })
    .from(obsidianNotes);
  const known = new Map(existing.map((r) => [r.path, r.mtime.getTime()]));

  let indexed = 0;
  for (const file of files) {
    const s = await stat(file);
    const knownMtime = known.get(file);
    if (knownMtime !== undefined && Math.abs(knownMtime - s.mtimeMs) < 1000) {
      continue; // unchanged
    }
    if (s.size > MAX_FILE_BYTES) continue;
    const content = await readFile(file, "utf8");
    const name = relative(root, file).replace(/\.md$/, "");
    const fields = {
      title: extractTitle(content, name),
      excerpt: toExcerpt(content),
      mtime: new Date(s.mtimeMs),
      updatedAt: new Date(),
    };
    await db
      .insert(obsidianNotes)
      .values({ path: file, ...fields })
      .onConflictDoUpdate({ target: obsidianNotes.path, set: fields });
    indexed++;
  }

  // Remove index rows for files deleted from the vault.
  let removed = 0;
  if (files.length > 0) {
    const gone = await db
      .delete(obsidianNotes)
      .where(notInArray(obsidianNotes.path, files))
      .returning({ id: obsidianNotes.id });
    removed = gone.length;
  }

  if (indexed || removed) {
    await sql.notify("obsidian_changed", `${indexed}/${removed}`);
    log(`obsidian sync: ${indexed} indexed, ${removed} removed`);
  }
  return { indexed, removed };
}

export async function vaultStats() {
  const [row] = await db
    .select({
      total: dsql<number>`count(*)`,
      // Embeddings now live in the unified index (kind='vault').
      embedded: dsql<number>`(select count(*) from search_index where kind = 'vault' and embedding is not null)`,
      lastSync: dsql<Date | null>`max(${obsidianNotes.updatedAt})`,
    })
    .from(obsidianNotes);
  return {
    total: Number(row.total),
    embedded: Number(row.embedded),
    // Raw SQL aggregates come back as strings, not Dates.
    lastSync: row.lastSync ? new Date(row.lastSync as unknown as string) : null,
  };
}

export const obsidianJobs: ModuleJob[] = [
  {
    channel: "obsidian_sync",
    schedule: "*/30 * * * *",
    // payload is "" for the cron tick; "manual"/"settings-changed" when the
    // user acted — only then is an error surfaced as a notification.
    handle: async (payload) => {
      await syncVault(console.log, { notifyOnError: payload !== "" });
    },
  },
];

/** Read a full vault note — path must stay inside the configured vault. */
export async function readVaultNote(path: string): Promise<string> {
  const root = (await getSetting(OBSIDIAN_PATH_KEY))?.trim();
  if (!root) throw new Error("no vault configured");
  const { resolve } = await import("node:path");
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(root))) {
    throw new Error("path escapes the vault");
  }
  return (await readFile(resolved, "utf8")).slice(0, 50_000);
}
