/**
 * Ingest loop for Telegram sources. For each enabled channel: pull new posts
 * (or backfill on the first run), enrich each with its linked-article text,
 * run the cheap relevance gate, and store it. Idempotent via `lastSeenId` — a
 * re-run never re-ingests a post (the processed-ledger rule).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { fetchChannelPosts, fetchUrlText } from "./fetch";
import { classifyRelevance } from "./relevance";
import { needsTranslation, translateToEnglish } from "./translate";
import { telegramChannels, telegramPosts } from "./schema";

const log = (m: string) =>
  console.log(`[telegram ${new Date().toISOString()}] ${m}`);

export async function ingestChannel(channelId: string): Promise<void> {
  const [ch] = await db
    .select()
    .from(telegramChannels)
    .where(eq(telegramChannels.id, channelId));
  if (!ch || ch.enabled !== "true") return;

  const sinceDate =
    ch.lastSeenId == null
      ? new Date(Date.now() - ch.backfillDays * 86_400_000)
      : null;
  const posts = await fetchChannelPosts(ch.username, {
    sinceId: ch.lastSeenId,
    sinceDate,
  });
  log(`${ch.username}: ${posts.length} new post(s)` + (sinceDate ? ` (backfill ${ch.backfillDays}d)` : ""));

  // Skip any we already have (belt & suspenders over the unique index).
  const existing = new Set(
    (
      await db
        .select({ postId: telegramPosts.postId })
        .from(telegramPosts)
        .where(
          and(
            eq(telegramPosts.channel, ch.username),
            inArray(
              telegramPosts.postId,
              posts.length ? posts.map((p) => p.postId) : [-1],
            ),
          ),
        )
    ).map((r) => r.postId),
  );

  let relevantCount = 0;
  // Advance the cursor as we go and checkpoint it periodically, so an
  // interrupted backfill (worker restart, crash) resumes from where it left off
  // instead of re-scanning the whole window next run (the state-ledger rule).
  let cursor = ch.lastSeenId ?? 0;
  let processed = 0;
  for (const p of posts) {
    cursor = Math.max(cursor, p.postId);
    if (existing.has(p.postId)) continue;
    try {
      // Enrich with the first link's readable text (ift.tt → real article).
      const linkedText = p.urls[0] ? await fetchUrlText(p.urls[0]) : "";
      const verdict = await classifyRelevance({
        text: p.text,
        linkedText,
        include: ch.criteria,
        exclude: ch.exclude,
      });
      // Foreign-language posts get an English gloss so cross-lingual search works.
      const textEn = needsTranslation(p.text) ? await translateToEnglish(p.text) : null;
      const [row] = await db
        .insert(telegramPosts)
        .values({
          channel: ch.username,
          postId: p.postId,
          postedAt: p.postedAt,
          text: p.text,
          urls: p.urls,
          linkedText: linkedText || null,
          textEn,
          relevant: verdict.relevant ? "yes" : "no",
          relevanceWhy: verdict.why,
        })
        .onConflictDoNothing()
        .returning();
      if (verdict.relevant && row) {
        relevantCount++;
        // Fires the (Phase-2) source trigger — a routine bound to this channel
        // runs on this post. Nothing listens yet; harmless until then.
        await sql.notify("telegram_new_post", row.id);
      }
    } catch (e) {
      // One bad post (a hung link fetch, a gate hiccup) must not abort the
      // whole channel's ingest — skip it and keep going.
      log(`${ch.username} post ${p.postId} skipped: ${String(e).slice(0, 120)}`);
    }
    // Checkpoint every 10 new posts so progress survives an interruption.
    if (++processed % 10 === 0) {
      await db
        .update(telegramChannels)
        .set({ lastSeenId: cursor, lastRunAt: new Date() })
        .where(eq(telegramChannels.id, ch.id));
    }
  }

  await db
    .update(telegramChannels)
    .set({ lastSeenId: cursor, lastRunAt: new Date() })
    .where(eq(telegramChannels.id, ch.id));
  await sql.notify("telegram_changed", ch.id);
  log(`${ch.username}: ingested ${posts.length}, ${relevantCount} relevant, cursor @ ${cursor}`);
}

export async function ingestAll(): Promise<void> {
  const chans = await db
    .select({ id: telegramChannels.id })
    .from(telegramChannels)
    .where(eq(telegramChannels.enabled, "true"));
  for (const c of chans) {
    await ingestChannel(c.id).catch((e) => log(`ingest ${c.id} failed: ${e}`));
  }
}

export const telegramJobs: ModuleJob[] = [
  {
    // NOTIFY-driven "ingest now" for one channel.
    channel: "telegram_ingest",
    handle: async (payload) => {
      if (payload) await ingestChannel(payload);
      else await ingestAll();
    },
  },
  {
    // Poll every 15 min. Idempotent, so overlap/misfire is harmless.
    channel: "telegram_sweep",
    schedule: "*/15 * * * *",
    handle: async () => {
      await ingestAll();
    },
  },
];
