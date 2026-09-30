import { sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import { notionPages } from "./schema";

const NOTION = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
/** JSON array of {token, workspace} — supports multiple Notion workspaces. */
export const NOTION_TOKENS_KEY = "notion_tokens";
const LEGACY_TOKEN_KEY = "notion_token"; // single-token setting from v1

export interface NotionConnection {
  token: string;
  workspace: string;
}

function headersFor(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": VERSION,
    "Content-Type": "application/json",
  };
}

/** All connected workspaces. Migrates a legacy single token on first read. */
export async function getConnections(): Promise<NotionConnection[]> {
  const raw = await getSetting(NOTION_TOKENS_KEY);
  let conns: NotionConnection[] = [];
  if (raw) {
    try {
      conns = (JSON.parse(raw) as NotionConnection[]).filter((c) => c?.token);
    } catch {
      conns = [];
    }
  }
  const legacy = (await getSetting(LEGACY_TOKEN_KEY))?.trim();
  if (legacy && !conns.some((c) => c.token === legacy)) {
    const probe = await probeWorkspace(legacy);
    conns.push({ token: legacy, workspace: "bad" in probe ? "Notion" : probe.name });
    await setSetting(NOTION_TOKENS_KEY, JSON.stringify(conns));
    await setSetting(LEGACY_TOKEN_KEY, "");
  }
  return conns;
}

async function saveConnections(conns: NotionConnection[]) {
  await setSetting(NOTION_TOKENS_KEY, JSON.stringify(conns));
}

export async function notionConnected(): Promise<boolean> {
  return (await getConnections()).length > 0;
}

/** Public view (no tokens): workspace names for the UI. */
export async function connectedWorkspaces(): Promise<string[]> {
  return (await getConnections()).map((c) => c.workspace);
}

/**
 * Probe a token via /users/me. Rejects ONLY on an explicit 401 (a genuinely bad
 * token); a network hiccup or other error accepts optimistically with a fallback
 * name (the sync will surface real problems later). Never throws.
 */
async function probeWorkspace(
  token: string,
): Promise<{ bad: true } | { name: string }> {
  try {
    const res = await fetch(`${NOTION}/users/me`, {
      headers: headersFor(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return { bad: true };
    if (!res.ok) return { name: "Notion" };
    const d = (await res.json()) as {
      name?: string;
      bot?: { workspace_name?: string };
    };
    return { name: d.bot?.workspace_name || d.name || "Notion" };
  } catch {
    return { name: "Notion" };
  }
}

/**
 * Add a workspace by token. Validates it, dedupes by token, stores it, and does
 * a first sync. Distinct workspaces sharing a name get suffixed so removal and
 * page-attribution stay unambiguous.
 */
export async function addConnection(
  token: string,
): Promise<{ workspace: string } | { badToken: true }> {
  const t = token.trim();
  const probe = await probeWorkspace(t);
  if ("bad" in probe) return { badToken: true };

  const conns = (await getConnections()).filter((c) => c.token !== t);
  let name = probe.name;
  for (let i = 2; conns.some((c) => c.workspace === name); i++)
    name = `${probe.name} (${i})`;
  conns.push({ token: t, workspace: name });
  await saveConnections(conns);
  await syncOne(t, name);
  await sql.notify("notion_changed", "");
  return { workspace: name };
}

/** Disconnect one workspace and drop its indexed pages. */
export async function removeConnection(workspace: string): Promise<void> {
  const conns = await getConnections();
  await saveConnections(conns.filter((c) => c.workspace !== workspace));
  await db.delete(notionPages).where(dsql`${notionPages.workspace} = ${workspace}`);
  await sql.notify("notion_changed", "");
}

interface NotionPageObj {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, { type: string; title?: { plain_text: string }[] }>;
}

function extractTitle(p: NotionPageObj): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop.type === "title" && prop.title?.length) {
      return prop.title.map((t) => t.plain_text).join("").trim() || "(untitled)";
    }
  }
  return "(untitled)";
}

async function pageText(id: string, headers: HeadersInit): Promise<string> {
  const res = await fetch(`${NOTION}/blocks/${id}/children?page_size=50`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return "";
  const { results = [] } = (await res.json()) as { results?: Record<string, unknown>[] };
  const parts: string[] = [];
  for (const b of results) {
    const type = b.type as string | undefined;
    if (!type) continue;
    const block = b[type] as { rich_text?: { plain_text: string }[] } | undefined;
    if (Array.isArray(block?.rich_text)) {
      parts.push(block.rich_text.map((r) => r.plain_text).join(""));
    }
  }
  return parts.join("\n").slice(0, 4000);
}

/** Sync one workspace's pages, tagging each with its workspace name. */
async function syncOne(token: string, workspace: string): Promise<number> {
  const headers = headersFor(token);
  const searchRes = await fetch(`${NOTION}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter: { value: "page", property: "object" }, page_size: 50 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!searchRes.ok) throw new Error(`notion search → ${searchRes.status}`);
  const { results = [] } = (await searchRes.json()) as { results?: NotionPageObj[] };

  let n = 0;
  for (const p of results) {
    try {
      const title = extractTitle(p);
      // Content is best-effort: if Notion is degraded and the block fetch fails,
      // still persist the page (title/url from search) — don't lose the batch.
      const content = await pageText(p.id, headers).catch(() => "");
      const lastEdited = p.last_edited_time ? new Date(p.last_edited_time) : null;
      // NOTE: a raw JS Date can't be bound inside a sql`` template (postgres.js
      // rejects it) — pass an ISO string + ::timestamptz. Only the setWhere is
      // affected; typed .values()/.set() bind the Date fine.
      const leIso = lastEdited ? lastEdited.toISOString() : null;
      await db
        .insert(notionPages)
        .values({ id: p.id, workspace, title, url: p.url ?? null, content, lastEdited })
        .onConflictDoUpdate({
          target: notionPages.id,
          set: { workspace, title, url: p.url ?? null, content, lastEdited },
          // Re-embed only changed pages; always keep workspace attribution correct.
          setWhere: dsql`${notionPages.lastEdited} is distinct from ${leIso}::timestamptz or ${notionPages.workspace} is distinct from ${workspace}`,
        });
      n++;
    } catch {
      // One bad page shouldn't abort the whole workspace — skip and continue.
    }
  }
  return n;
}

/** Sync every connected workspace. Returns totals; never throws for "not set up". */
export async function syncNotion(
  log: (m: string) => void = () => {},
): Promise<{ synced: number; workspaces: number; failedWorkspaces: string[] } | { needsToken: true }> {
  const conns = await getConnections();
  if (conns.length === 0) return { needsToken: true };
  let synced = 0;
  const failedWorkspaces: string[] = [];
  for (const c of conns) {
    try {
      synced += await syncOne(c.token, c.workspace);
    } catch (e) {
      failedWorkspaces.push(c.workspace);
      log(`notion "${c.workspace}" failed: ${String(e).slice(0, 140)}`);
    }
  }
  await sql.notify("notion_changed", "");
  log(`notion: synced ${synced} pages across ${conns.length} workspace(s)`);
  return { synced, workspaces: conns.length, failedWorkspaces };
}
