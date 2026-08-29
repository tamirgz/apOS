import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Telegram as a SOURCE (not a chat): apOS reads a public channel's posts via
 * its `t.me/s/<name>` web preview — no bot, no API key, no login. Each post is
 * enriched (linked-article text pulled in) and cheaply relevance-gated by a
 * local model, so only the posts that matter reach an (expensive) routine.
 */
export const telegramChannels = pgTable("telegram_channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Public @username, without the @ (e.g. "RedXCyberSecurity"). */
  username: text("username").notNull().unique(),
  enabled: text("enabled").notNull().default("true"),
  /** Relevant topics — one per line. A post's core subject must match one. */
  criteria: text("criteria").notNull().default(""),
  /** Not-relevant topics, even if cybersecurity — one per line. Explicit
   *  negatives give the small gate model far less room to over-fire. */
  exclude: text("exclude").notNull().default(""),
  /** How far back to reach on the very first ingest. */
  backfillDays: integer("backfill_days").notNull().default(14),
  /** Ledger: the highest telegram message id already ingested (idempotency). */
  lastSeenId: integer("last_seen_id"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const telegramPosts = pgTable(
  "telegram_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: text("channel").notNull(),
    /** Numeric telegram message id — monotonic per channel, so it's the cursor. */
    postId: integer("post_id").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    text: text("text").notNull().default(""),
    /** Links found in the post (usually ift.tt shorteners). */
    urls: jsonb("urls").$type<string[]>().notNull().default([]),
    /** Readable text pulled from the linked article(s), truncated. */
    linkedText: text("linked_text"),
    /** English translation of a non-English post, for CROSS-LINGUAL search:
     *  nomic embeddings cluster by language, so a Russian/Hebrew post is invisible
     *  to an English query. We embed this English gloss instead, so an English
     *  search retrieves the original foreign post. Null = post is already English. */
    textEn: text("text_en"),
    /** The relevance gate's verdict: "yes" | "no" | null (not yet judged). */
    relevant: text("relevant"),
    relevanceWhy: text("relevance_why"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("telegram_posts_channel_post").on(t.channel, t.postId),
    index("telegram_posts_channel").on(t.channel, t.postId),
  ],
);

export type TelegramPost = typeof telegramPosts.$inferSelect;
export type TelegramChannel = typeof telegramChannels.$inferSelect;
