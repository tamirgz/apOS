"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { telegramChannels } from "./schema";

function revalidate() {
  revalidatePath("/m/telegram");
}

/** Register a public channel as a source, with the domain its posts are judged against. */
export async function addChannel(input: {
  username: string;
  criteria: string;
  exclude?: string;
  backfillDays?: number;
}) {
  const { DEFAULT_EXCLUDE } = await import("./relevance");
  const username = input.username.trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\/(s\/)?/, "");
  if (!username) return { ok: false as const, error: "Enter a channel username." };
  const [row] = await db
    .insert(telegramChannels)
    .values({
      username,
      criteria: input.criteria.trim(),
      // Seed the negatives so a new channel starts with sensible guardrails.
      exclude: (input.exclude ?? DEFAULT_EXCLUDE).trim(),
      backfillDays: input.backfillDays ?? 14,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return { ok: false as const, error: `@${username} is already followed.` };
  // Kick a first ingest (backfill) in the worker.
  await sql.notify("telegram_ingest", row.id);
  revalidate();
  return { ok: true as const, channel: row };
}

export async function ingestNow(channelId: string) {
  await sql.notify("telegram_ingest", channelId);
  revalidate();
}

export async function setChannelEnabled(channelId: string, enabled: boolean) {
  await db
    .update(telegramChannels)
    .set({ enabled: enabled ? "true" : "false" })
    .where(eq(telegramChannels.id, channelId));
  revalidate();
}

/** Edit what "relevant" means for this channel — the RELEVANT topics and the
 *  explicit NOT-RELEVANT topics the gate judges each post against. Takes effect
 *  on the next ingest/sweep. */
export async function setChannelCriteria(
  channelId: string,
  criteria: string,
  exclude: string,
) {
  await db
    .update(telegramChannels)
    .set({ criteria: criteria.trim(), exclude: exclude.trim() })
    .where(eq(telegramChannels.id, channelId));
  revalidate();
}

export async function deleteChannel(channelId: string) {
  await db.delete(telegramChannels).where(eq(telegramChannels.id, channelId));
  revalidate();
}
