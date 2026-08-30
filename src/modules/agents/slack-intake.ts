import { eq, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import type { ModuleJob } from "@/core/modules/types.server";
import { externalReports } from "./schema";

export const SLACK_KEYS = {
  token: "slack_bot_token",
  channels: "slack_report_channels",
} as const;

const MAX_BODY = 30_000;

interface SlackMessage {
  type: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

export async function slackApi<T>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(
    `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
  return data;
}

/** POST variant for write methods (chat.postMessage, reactions.add). */
export async function slackPost<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
  return data;
}

/**
 * Slack mrkdwn → Markdown (not stripped plain text): links stay clickable,
 * bold/italic/bullets survive, emoji shortcodes become real emoji, and
 * Slack's HTML entities are unescaped.
 */
/** Slack-flavoured shortcodes that differ from the standard emoji names. */
const SLACK_EMOJI_ALIASES: Record<string, string> = {
  robot_face: "robot",
  "e-mail": "email",
  thumbsup: "+1",
  thumbsdown: "-1",
  slightly_smiling_face: "slightly_smiling_face",
  white_frowning_face: "frowning",
  simple_smile: "smile",
};

export function slackToMarkdown(text: string, emojify: (s: string) => string) {
  let out = text
    // Links first — before entity unescaping, so labels can't break parsing.
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "<$1>")
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, "[$2](mailto:$1)")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1");

  // Slack HTML-escapes these three in message text.
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  out = out
    // Slack bold is *single* asterisks; Markdown needs double.
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, "$1**$2**")
    .replace(/~([^~\n]+)~/g, "~~$1~~")
    // Slack bullets → markdown list items.
    .replace(/^[ \t]*[•·][ \t]*/gm, "- ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  // Slack-only shortcodes → standard names, then real emoji; anything still
  // unresolved is dropped rather than shown as raw ":name:".
  out = out.replace(
    /:([a-z0-9_+-]+):/g,
    (m, name: string) => `:${SLACK_EMOJI_ALIASES[name] ?? name}:`,
  );
  out = emojify(out).replace(/:[a-z0-9_+-]{2,}:/g, "").replace(/ {2,}/g, " ");

  // A standalone italic line (optionally emoji-prefixed) is a section header
  // in these digests — promote it so the rendered view gets real hierarchy.
  out = out
    .split("\n")
    .map((line) => {
      const m = line
        .trim()
        .match(/^([\p{Extended_Pictographic}️\s]*)_([^_]{2,120})_$/u);
      return m ? `### ${(m[1] ?? "").trim()} ${m[2]}`.trim() : line;
    })
    .join("\n");

  return out;
}

/** Title = first meaningful line, with markdown/emoji stripped for the header. */
function titleOf(markdown: string, fallback: string): string {
  const first = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return fallback.slice(0, 150);
  return first
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

/**
 * Poll the configured Slack channels for new messages and ingest them as
 * external reports. This is how apOS sees Claude Desktop scheduled routines:
 * they post to Slack, and Slack is readable regardless of where they ran.
 */
export async function scanSlackReports(
  log: (m: string) => void = () => {},
): Promise<number> {
  const token = (await getSetting(SLACK_KEYS.token))?.trim();
  const channelList = (await getSetting(SLACK_KEYS.channels))?.trim();
  if (!token || !channelList) return 0;

  const channels = channelList
    .split(/[\s,]+/)
    .map((c) => c.trim().replace(/^#/, ""))
    .filter(Boolean);

  let fresh = 0;
  let failedChannels = 0;
  let lastError: unknown = null;
  for (const channel of channels) {
    try {
      // Resolve a display name once per channel (best-effort).
      const nameKey = `slack_channel_name:${channel}`;
      let name = await getSetting(nameKey);
      if (!name) {
        try {
          const info = await slackApi<{ channel: { name: string } }>(
            token,
            "conversations.info",
            { channel },
          );
          name = `#${info.channel.name}`;
          await setSetting(nameKey, name);
        } catch {
          name = channel;
        }
      }

      const cursorKey = `slack_last_ts:${channel}`;
      const lastTs = await getSetting(cursorKey);
      const history = await slackApi<{ messages: SlackMessage[] }>(
        token,
        "conversations.history",
        {
          channel,
          limit: "20",
          ...(lastTs ? { oldest: lastTs } : {}),
        },
      );

      const messages = (history.messages ?? [])
        // Skip joins/leaves and thread replies — only top-level posts.
        .filter((m) => m.type === "message" && !m.subtype && !m.thread_ts)
        .filter((m) => (m.text ?? "").trim().length > 0)
        .sort((a, b) => Number(a.ts) - Number(b.ts));

      const { emojify } = await import("node-emoji");
      for (const m of messages) {
        if (lastTs && Number(m.ts) <= Number(lastTs)) continue;
        const md = slackToMarkdown(m.text ?? "", emojify).slice(0, MAX_BODY);
        const fields = {
          kind: "slack" as const,
          origin: name,
          title: titleOf(md, `${name} report`),
          body: md,
          reportedAt: new Date(Number(m.ts) * 1000),
        };
        const source = `slack:${channel}:${m.ts}`;
        // Known already? Then this is a formatting refresh, not a new report —
        // update quietly, don't re-notify.
        const [known] = await db
          .select({ id: externalReports.id })
          .from(externalReports)
          .where(eq(externalReports.source, source))
          .limit(1);
        await db
          .insert(externalReports)
          .values({ source, ...fields })
          .onConflictDoUpdate({
            target: externalReports.source,
            set: { ...fields, ingestedAt: new Date() },
          });
        if (!known) {
          fresh++;
          const { notify } = await import("@/core/notify");
          await notify({
            title: `${name}: ${fields.title.slice(0, 80)}`,
            body: md.slice(0, 300),
            level: "info",
            source: `slack:${name}`,
            href: "/m/agents",
          });
        }
      }

      const newest = messages.at(-1)?.ts;
      if (newest) await setSetting(cursorKey, newest);
    } catch (e) {
      failedChannels++;
      lastError = e;
      log(`slack intake ${channel} failed: ${String(e).slice(0, 160)}`);
    }
  }

  // Every configured channel failing = the token/Slack is broken, not one flaky
  // channel — surface it through runJob's alerting instead of staying "healthy".
  if (channels.length > 0 && failedChannels === channels.length) {
    throw new Error(`all ${channels.length} slack intake channel(s) failed: ${String(lastError).slice(0, 200)}`);
  }

  if (fresh > 0) {
    await sql.notify("external_reports", String(fresh));
    log(`slack intake: ${fresh} new report(s)`);
  }
  return fresh;
}

/** Backfill recent history for a channel that was just configured. */
export async function backfillSlack(): Promise<void> {
  const channelList = (await getSetting(SLACK_KEYS.channels))?.trim();
  if (!channelList) return;
  for (const c of channelList.split(/[\s,]+/).filter(Boolean)) {
    await db.execute(
      dsql`delete from app_settings where key = ${`slack_last_ts:${c.replace(/^#/, "")}`}`,
    );
  }
}

export const slackIntakeJobs: ModuleJob[] = [
  {
    channel: "slack_intake",
    schedule: "*/5 * * * *",
    handle: async () => {
      await scanSlackReports(console.log);
    },
  },
];
