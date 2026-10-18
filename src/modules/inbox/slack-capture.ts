/**
 * Slack capture channel → Inbox. Any new top-level message in a configured
 * capture channel (e.g. #ai-os) is dropped into the inbox, where the existing
 * triage pipeline files it as a task / note / idea / knowledge / event. This
 * is distinct from the report intake (agents/slack-intake.ts), which feeds the
 * Agents page — capture is for things YOU want turned into work.
 *
 * Polling (not the Events API) because apOS runs locally with no public
 * endpoint: outbound conversations.history needs no inbound webhook. Idempotent
 * via a per-channel cursor plus a per-message `source` dedupe in the inbox.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";
import { matchProjectByText } from "@/core/embeddings";
import type { ModuleJob } from "@/core/modules/types.server";
import {
  SLACK_KEYS,
  slackApi,
  slackPost,
  slackToMarkdown,
} from "@/modules/agents/slack-intake";
import { captureInboxItem } from "./core";

export const SLACK_INBOX_KEY = "slack_inbox_channels";

const APP_BASE_URL = process.env.APP_BASE_URL?.trim() || "http://localhost:3777";

const KIND_EMOJI: Record<string, string> = {
  task: "✅",
  note: "📝",
  knowledge: "🔖",
  idea: "💡",
  event: "📅",
};

/** Set the created item's project link (only kinds that carry a projectRef). */
async function linkToProject(
  kind: string,
  itemId: string,
  projectId: string,
): Promise<void> {
  const ref = `projects:${projectId}`;
  if (kind === "task") {
    const { tasks } = await import("@/modules/tasks/schema");
    await db.update(tasks).set({ projectRef: ref, version: sql`${tasks.version} + 1` }).where(eq(tasks.id, itemId));
  } else if (kind === "note") {
    const { notes } = await import("@/modules/notes/schema");
    // Notes are multi-filed — set the array to this single matched project.
    await db.update(notes).set({ projectRefs: [ref] }).where(eq(notes.id, itemId));
  } else if (kind === "idea") {
    const { ideas } = await import("@/modules/ideas/schema");
    await db.update(ideas).set({ projectRef: ref }).where(eq(ideas.id, itemId));
  }
}

/**
 * After a Slack-captured item is triaged, reply in-thread so the user sees —
 * right in Slack — that it landed, how it was filed (task / note / idea…), and
 * which project it relates to. A strong project match is also linked on the
 * created item so it actually shows up under that project. Best-effort: never
 * throws, so a missing scope or channel can't break triage.
 */
export async function confirmSlackCapture(opts: {
  source: string | null;
  input: string;
  summary: string;
  route: { kind: string; label: string; href: string } | null;
  createdId?: string | null;
}): Promise<void> {
  const { source, input, summary, route, createdId } = opts;
  if (!source?.startsWith("slack:")) return;
  const token = (await getSetting(SLACK_KEYS.token))?.trim();
  if (!token) return;

  // source = "slack:<channel>:<ts>"
  const rest = source.slice("slack:".length);
  const idx = rest.indexOf(":");
  if (idx < 0) return;
  const channel = rest.slice(0, idx);
  const ts = rest.slice(idx + 1);

  try {
    let projectLine = "";
    if (route) {
      const match = await matchProjectByText(input);
      if (match) {
        // Only auto-link on a confident match; a weak one is reported as a
        // guess, not treated as fact.
        if (match.confidence === "strong" && createdId) {
          await linkToProject(route.kind, createdId, match.id).catch(() => {});
          projectLine = `\n📁 Project: *${match.name}*`;
        } else {
          projectLine = `\n📁 Possibly related to *${match.name}*`;
        }
      }
    }

    const emoji = route ? KIND_EMOJI[route.kind] ?? "📥" : "🤔";
    const heading = route
      ? `${emoji} Filed as *${route.label}*`
      : `${emoji} Captured — nothing actionable, left in the Inbox`;
    const link = route
      ? `\n<${APP_BASE_URL}${route.href}|Open in apOS>`
      : `\n<${APP_BASE_URL}/m/inbox|Open Inbox>`;
    const text = `${heading}\n_${summary}_${projectLine}${link}`;

    await slackPost(token, "chat.postMessage", {
      channel,
      thread_ts: ts,
      text,
      unfurl_links: false,
    }).catch(() => {});
    // At-a-glance tick on the original message (needs reactions:write).
    await slackPost(token, "reactions.add", {
      channel,
      timestamp: ts,
      name: "white_check_mark",
    }).catch(() => {});
  } catch {
    // best-effort confirmation; never surfaces as a triage failure
  }
}

const MAX_INPUT = 8_000;

interface SlackMessage {
  type: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

export async function scanSlackInbox(
  log: (m: string) => void = () => {},
): Promise<number> {
  const token = (await getSetting(SLACK_KEYS.token))?.trim();
  const channelList = (await getSetting(SLACK_INBOX_KEY))?.trim();
  if (!token || !channelList) return 0;

  const channels = channelList
    .split(/[\s,]+/)
    .map((c) => c.trim().replace(/^#/, ""))
    .filter(Boolean);

  let captured = 0;
  const { emojify } = await import("node-emoji");

  for (const channel of channels) {
    try {
      const cursorKey = `slack_inbox_last_ts:${channel}`;
      const lastTs = await getSetting(cursorKey);
      const history = await slackApi<{ messages: SlackMessage[] }>(
        token,
        "conversations.history",
        { channel, limit: "20", ...(lastTs ? { oldest: lastTs } : {}) },
      );

      const messages = (history.messages ?? [])
        // Top-level human posts only — no joins/leaves, no thread replies.
        .filter((m) => m.type === "message" && !m.subtype && !m.thread_ts)
        .filter((m) => (m.text ?? "").trim().length > 0)
        .sort((a, b) => Number(a.ts) - Number(b.ts));

      for (const m of messages) {
        if (lastTs && Number(m.ts) <= Number(lastTs)) continue;
        const md = slackToMarkdown(m.text ?? "", emojify).trim().slice(0, MAX_INPUT);
        if (!md) continue;
        const row = await captureInboxItem({
          input: md,
          source: `slack:${channel}:${m.ts}`,
        });
        if (row) captured++;
      }

      // Advance the cursor past EVERYTHING fetched — including messages we skip
      // (apOS's own bot posts, joins/leaves, thread replies) — not just the
      // human ones we captured. Otherwise a channel dominated by non-human
      // noise leaves the cursor stuck, re-scanning the same window every run.
      let newestSeen = lastTs ?? "";
      for (const m of history.messages ?? []) {
        if (!newestSeen || Number(m.ts) > Number(newestSeen)) newestSeen = m.ts;
      }
      if (newestSeen && newestSeen !== lastTs) {
        await setSetting(cursorKey, newestSeen);
      }
    } catch (e) {
      log(`slack inbox ${channel} failed: ${String(e).slice(0, 160)}`);
    }
  }

  if (captured > 0) log(`slack inbox: captured ${captured} message(s)`);
  return captured;
}

export const slackInboxJobs: ModuleJob[] = [
  {
    channel: "slack_inbox",
    schedule: "*/5 * * * *",
    handle: async () => {
      await scanSlackInbox(console.log);
    },
  },
];
