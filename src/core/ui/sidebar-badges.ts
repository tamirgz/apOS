"use server";

import { inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";

/**
 * The sidebar's "something is waiting for you" counts — so Today and Inbox
 * show their load without being clicked into (the "N pages to check manually"
 * problem). Cheap: two count queries, refreshed over the shared SSE stream.
 */
export async function getSidebarBadges(): Promise<{
  needsYou: number;
  inbox: number;
}> {
  const { countNeedsYou } = await import("@/modules/today/queries");
  const { inboxItems } = await import("@/modules/inbox/schema");
  const [needsYou, [inbox]] = await Promise.all([
    countNeedsYou(),
    db
      .select({ n: dsql<number>`count(*)` })
      .from(inboxItems)
      .where(inArray(inboxItems.status, ["new", "triaging", "failed", "error"])),
  ]);
  return { needsYou, inbox: Number(inbox.n) };
}
