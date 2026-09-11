"use server";

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { setRoute } from "@/core/ai/routing";
import { getSetting, setSetting } from "@/core/app-settings";
import { db, sql } from "@/core/db/client";
import type { AIProviderId } from "@/core/db/schema/ai-routes";
import { INTEGRATION_SETTING_KEYS } from "@/core/integrations/registry";
import { THEME_IDS } from "@/core/theme";
import { HEALTHCHECK_INTERVAL_KEY } from "@/core/health";

// Generated from the integration registry, so every field the Connections UI
// renders is saveable by construction. Plus a few non-connection settings that
// also go through saveIntegration (e.g. the embedding model, set on the Models
// page).
const ALLOWED_INTEGRATION_KEYS = new Set([
  ...INTEGRATION_SETTING_KEYS,
  "embedding_model",
]);

export async function disconnectGoogle() {
  const { db } = await import("@/core/db/client");
  const { appSettings } = await import("@/core/db/schema/app-settings");
  const { eq } = await import("drizzle-orm");
  await db
    .delete(appSettings)
    .where(eq(appSettings.key, "google_refresh_token"));
  revalidatePath("/m/settings");
}

export async function saveMemoryBlock(label: string, value: string) {
  const { updateMemoryBlock } = await import("@/core/memory");
  await updateMemoryBlock(label, value, "replace");
  revalidatePath("/m/settings");
}

export async function createMemoryBlock(label: string, description: string) {
  const { createMemoryBlockDef } = await import("@/core/memory");
  await createMemoryBlockDef(label, description);
  revalidatePath("/m/settings");
}

export async function saveIntegration(key: string, value: string) {
  if (!ALLOWED_INTEGRATION_KEYS.has(key)) throw new Error("unknown setting");
  let cleaned = value.trim();
  if (key === "obsidian_vault_path") {
    // Users paste shell-quoted paths ('/My Drive/…') — strip wrapping quotes,
    // expand ~, drop trailing slash.
    cleaned = cleaned
      .replace(/^['"]+/, "")
      .replace(/['"]+$/, "")
      .replace(/\/+$/, "");
    if (cleaned.startsWith("~/")) {
      const { homedir } = await import("node:os");
      cleaned = homedir() + cleaned.slice(1);
    }
  }
  await setSetting(key, cleaned);
  if (key === "calendar_ics_url" && value.trim()) {
    await sql.notify("calendar_sync", "settings-changed");
  }
  if (key === "obsidian_vault_path" && value.trim()) {
    await sql.notify("obsidian_sync", "settings-changed");
  }
  if (key === "slack_report_channels" && value.trim()) {
    // New channel list → re-read recent history, then poll.
    const { backfillSlack } = await import("@/modules/agents/slack-intake");
    await backfillSlack();
    await sql.notify("slack_intake", "settings-changed");
  }
  revalidatePath("/m/settings");
}

export async function saveRoute(
  taskKey: string,
  provider: AIProviderId,
  model: string,
) {
  if (!model.trim()) throw new Error("model is required");
  await setRoute(taskKey, provider, model);
  revalidatePath("/m/settings");
}

/** Persist the selected appearance theme (applied as <html data-theme>). */
export async function saveTheme(id: string) {
  if (!THEME_IDS.includes(id)) throw new Error("unknown theme");
  await setSetting("theme", id);
  // Re-render the root layout so the SSR data-theme matches on next load.
  revalidatePath("/", "layout");
}

/** Persist the model-server health-check interval (minutes; 0 = off). */
export async function saveHealthInterval(min: number) {
  const v = Number.isFinite(min) && min >= 0 ? Math.floor(min) : 60;
  await setSetting(HEALTHCHECK_INTERVAL_KEY, String(v));
  revalidatePath("/m/settings");
}

/** Run the model-server health check on demand (updates state + alerts on a
 *  change), returning the current per-server status for the UI. */
export async function checkModelServersNow() {
  const { runHealthCheckAndNotify } = await import("@/core/health");
  return runHealthCheckAndNotify();
}

// ── Local one-click auto-detect (B2) ─────────────────────────────────────────

/** Read Obsidian's own vault registry and return the vaults that still exist. */
export async function detectObsidianVaults(): Promise<
  { path: string; name: string }[]
> {
  const { homedir } = await import("node:os");
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { basename, join } = await import("node:path");
  const cfg = join(
    homedir(),
    "Library",
    "Application Support",
    "obsidian",
    "obsidian.json",
  );
  try {
    const json = JSON.parse(await readFile(cfg, "utf8")) as {
      vaults?: Record<string, { path?: string }>;
    };
    const seen = new Set<string>();
    return Object.values(json.vaults ?? {})
      .map((v) => v.path)
      .filter((p): p is string => !!p && existsSync(p) && !seen.has(p) && (seen.add(p), true))
      .map((p) => ({ path: p, name: basename(p) }));
  } catch {
    return [];
  }
}

/** Point the Obsidian integration at a detected vault (reuses save's cleanup +
 *  the obsidian_sync NOTIFY). */
export async function useObsidianVault(path: string) {
  await saveIntegration("obsidian_vault_path", path);
}

/** Probe a running LM Studio server; on success, save its endpoint + model list
 *  so the `mlx` provider is wired with one click. Embedding models are skipped
 *  (they belong to Ollama). */
export async function detectMlx(): Promise<{
  ok: boolean;
  models: number;
  baseUrl?: string;
}> {
  const base = (
    (await getSetting("mlx_base_url")) ||
    process.env.MLX_BASE_URL ||
    "http://localhost:1234/v1"
  ).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, models: 0 };
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => !/embed/i.test(id));
    await setSetting("mlx_base_url", base);
    if (ids.length) await setSetting("mlx_models", ids.join(", "));
    revalidatePath("/m/settings");
    return { ok: true, models: ids.length, baseUrl: base };
  } catch {
    return { ok: false, models: 0 };
  }
}

/** List the Slack channels the bot can see, for the channel picker (replaces
 *  pasting comma-separated IDs). Needs channels:read / groups:read on the token. */
export async function listSlackChannels(): Promise<{
  ok: boolean;
  error?: string;
  channels?: { id: string; name: string; member: boolean }[];
}> {
  const token = (await getSetting("slack_bot_token"))?.trim();
  if (!token) return { ok: false, error: "add a bot token first" };
  try {
    const { slackApi } = await import("@/modules/agents/slack-intake");
    type ConvList = { channels: { id: string; name: string; is_member: boolean }[] };
    const list = (types: string) =>
      slackApi<ConvList>(token, "conversations.list", {
        types,
        exclude_archived: "true",
        limit: "1000",
      });
    // Private channels need groups:read, which is OPTIONAL — a bot with only
    // channels:read can still see public channels. So try both, and if Slack
    // rejects the private half for missing_scope, fall back to public-only
    // instead of failing the whole integration.
    let data: ConvList;
    try {
      data = await list("public_channel,private_channel");
    } catch (e) {
      if (/missing_scope/.test(String(e))) {
        data = await list("public_channel");
      } else {
        throw e;
      }
    }
    const channels = (data.channels ?? [])
      .map((c) => ({ id: c.id, name: c.name, member: c.is_member }))
      .sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
    return { ok: true, channels };
  } catch (e) {
    const msg = String(e);
    if (/missing_scope/.test(msg))
      return {
        ok: false,
        // Public listing itself failed, so channels:read is what's missing.
        error:
          "the bot lacks channels:read — add it in the Slack app config and re-install to the workspace (add groups:read too if you want private channels)",
      };
    return { ok: false, error: msg.replace(/^Error:\s*/, "") };
  }
}

/**
 * Live check that the Claude Max subscription actually WORKS — not just that a
 * token is present. A tiny ping through the anthropic provider surfaces an
 * expired OAuth session (which mere presence can't detect).
 */
export async function verifyClaudeAuth(): Promise<{ valid: boolean; error?: string }> {
  const { providers } = await import("@/core/ai/routing");
  let ok = false;
  let err = "";
  try {
    for await (const ev of providers.anthropic.run({
      system: "Reply with the single word OK.",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      toolCtx: { db },
      model: "claude-haiku-4-5-20251001",
      maxTurns: 1,
      track: { source: "test", label: "connection test" },
    })) {
      if (ev.type === "done" && ev.text?.trim()) ok = true;
      if (ev.type === "error") err = ev.message;
    }
  } catch (e) {
    err = String(e);
  }
  return { valid: ok && !err, error: err ? err.slice(0, 200) : undefined };
}

/**
 * Save a fresh CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) into
 * .env.local and restart the agent worker so it reloads. The token is written
 * server-side only and never returned; a running process reads .env.local at
 * start, so a restart is required for it to take effect.
 */
export async function reconnectClaude(
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const t = (token ?? "").trim();
  if (t.length < 20) return { ok: false, message: "That doesn't look like a valid token." };
  if (/\s/.test(t)) return { ok: false, message: "The token should be a single string with no spaces." };
  const path = join(process.cwd(), ".env.local");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // new file
  }
  const line = `CLAUDE_CODE_OAUTH_TOKEN=${t}`;
  content = /^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=.*$/m.test(content)
    ? content.replace(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=.*$/m, line)
    : `${content.trimEnd()}\n${line}\n`;
  try {
    writeFileSync(path, content);
  } catch (e) {
    return { ok: false, message: `Could not write .env.local: ${String(e).slice(0, 120)}` };
  }
  let restarted = false;
  try {
    const uid = process.getuid?.() ?? 0;
    await promisify(execFile)(
      "launchctl",
      ["kickstart", "-k", `gui/${uid}/com.aios.worker`],
      { timeout: 6000 },
    );
    restarted = true;
  } catch {
    // best-effort — the user can restart manually
  }
  revalidatePath("/m/settings");
  return {
    ok: true,
    message: restarted
      ? "Token saved and the agent worker was restarted. Restart the web app too so chat uses it."
      : "Token saved to .env.local — restart the worker and web app for it to take effect.",
  };
}
