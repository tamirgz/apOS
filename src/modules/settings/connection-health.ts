import type { ModuleJob } from "@/core/modules/types.server";
import { and, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { attentionItems } from "@/modules/today/schema";

/**
 * Connection health check — a once-daily probe of the WEB-BASED services apOS
 * depends on, so a silently-expired credential (the Claude Max OAuth token has
 * expired mid-work before) surfaces as an actionable card instead of a failed
 * run you notice hours later.
 *
 * Principles:
 *  - CONFIGURED-ONLY: probe a service only when its credential is present, so we
 *    never nag about integrations you don't use. Reconnection is about a
 *    previously-working service that broke, not first-time setup.
 *  - IDEMPOTENT: one stable card title per service → insertAttentionItem dedupes
 *    on it, so a service that stays down for days shows ONE open card, not one
 *    per probe.
 *  - SELF-CLOSING: a passing probe resolves any open card for that service, so a
 *    card you fixed doesn't linger.
 *  - Google is intentionally omitted — its Calendar/Gmail sync already raises its
 *    own "Reconnect Google" card on invalid_grant (see calendar/google.ts).
 */
const CARD_HREF = "/m/settings/connections";

interface Probe {
  label: string; // human service name — also the stable card identity
  configured: () => Promise<boolean>;
  check: () => Promise<{ ok: boolean; error?: string }>;
}

/** listModels() hits the provider's real endpoint with the configured key, so a
 *  bad key or dead endpoint throws — a good cheap auth+connectivity probe. */
function listModelsProbe(id: "gemini" | "openrouter" | "nvidia" | "tokenharbor") {
  return async () => {
    try {
      const { providers } = await import("@/core/ai/routing");
      const models = await providers[id].listModels();
      return { ok: Array.isArray(models) && models.length > 0 };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 160) };
    }
  };
}

async function buildProbes(): Promise<Probe[]> {
  const { getSetting } = await import("@/core/app-settings");
  const has = async (k: string) => !!(await getSetting(k).catch(() => null))?.trim();
  const env = (k: string) => !!process.env[k]?.trim();

  return [
    {
      // The one that actually expires. verifyClaudeAuth pings Haiku — presence of
      // a token can't detect an expired OAuth session, a live call can.
      label: "Claude (Max subscription)",
      configured: async () => env("CLAUDE_CODE_OAUTH_TOKEN"),
      check: async () => {
        const { verifyClaudeAuth } = await import("./actions");
        const r = await verifyClaudeAuth();
        return { ok: r.valid, error: r.error };
      },
    },
    {
      label: "Gemini",
      configured: () => has("gemini_api_key"),
      check: listModelsProbe("gemini"),
    },
    {
      label: "OpenRouter",
      configured: async () => (await has("openrouter_api_key")) || env("OPENROUTER_API_KEY"),
      check: listModelsProbe("openrouter"),
    },
    {
      label: "Token Harbor",
      configured: async () => (await has("tokenharbor_api_key")) || env("TOKENHARBOR_API_KEY"),
      check: listModelsProbe("tokenharbor"),
    },
    {
      label: "NVIDIA",
      configured: async () => env("NVIDIA_API_KEY"),
      check: listModelsProbe("nvidia"),
    },
    {
      label: "SearXNG web search",
      configured: async () => (await has("searxng_url")) || env("SEARXNG_URL"),
      check: async () => {
        const url =
          ((await getSetting("searxng_url").catch(() => null))?.trim() ||
            process.env.SEARXNG_URL ||
            "").replace(/\/$/, "");
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
          // Any live response (even a 4xx from a picky instance) proves it's
          // reachable; only a network failure or 5xx means "down".
          return res.status < 500
            ? { ok: true }
            : { ok: false, error: `HTTP ${res.status}` };
        } catch (e) {
          return { ok: false, error: String(e).slice(0, 160) };
        }
      },
    },
    {
      label: "Slack",
      configured: () => has("slack_bot_token"),
      check: async () => {
        const { listSlackChannels } = await import("./actions");
        const r = await listSlackChannels();
        return { ok: r.ok, error: r.error };
      },
    },
  ];
}

function cardTitle(label: string): string {
  return `Reconnect ${label}`;
}

/** Resolve any OPEN card for this service — a service that recovered shouldn't
 *  leave a stale reconnect card behind. Keyed on the exact card title. */
async function resolveOpenCard(label: string): Promise<void> {
  await db
    .update(attentionItems)
    .set({ status: "done" })
    .where(
      and(
        eq(attentionItems.title, cardTitle(label)),
        eq(attentionItems.status, "open"),
      ),
    )
    .catch(() => {});
}

export async function checkConnections(): Promise<{
  checked: number;
  failed: string[];
}> {
  const probes = await buildProbes();
  const failed: string[] = [];
  let checked = 0;

  for (const p of probes) {
    let configured = false;
    try {
      configured = await p.configured();
    } catch {
      configured = false;
    }
    if (!configured) continue;
    checked++;

    let result: { ok: boolean; error?: string };
    try {
      result = await p.check();
    } catch (e) {
      result = { ok: false, error: String(e).slice(0, 160) };
    }

    if (result.ok) {
      await resolveOpenCard(p.label); // recovered → close any stale card
      continue;
    }

    failed.push(p.label);
    const { insertAttentionItem } = await import("@/modules/today/core");
    await insertAttentionItem({
      type: "do",
      title: cardTitle(p.label),
      body:
        `A daily connection check couldn't reach ${p.label}` +
        (result.error ? ` (${result.error})` : "") +
        `. Reconnect or refresh the credential in Settings → Connections to restore it.`,
      source: "system",
      urgency: 18,
      href: CARD_HREF,
    }).catch(() => {});
  }

  return { checked, failed };
}

export const connectionHealthJobs: ModuleJob[] = [
  {
    channel: "connection_health",
    schedule: "0 9 * * *", // once daily at 09:00 — auth tokens last weeks
    handle: async () => {
      await checkConnections();
    },
  },
];
