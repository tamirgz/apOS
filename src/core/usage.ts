/**
 * Server-side usage events — the twin of the client `track()` beacon, for key
 * actions that already run as server actions (create a work item, dismiss a
 * card, ask a question…). Recording at the action is more reliable than a
 * client click handler: it fires however the action was reached. Best-effort
 * and fire-and-forget: a telemetry failure never fails the action.
 */
import { db } from "@/core/db/client";
import { uiEvents } from "@/core/db/schema/ui-events";

export function recordUsage(
  event: string,
  opts: { entityRef?: string | null; meta?: Record<string, unknown> } = {},
): void {
  void db
    .insert(uiEvents)
    .values({ event, entityRef: opts.entityRef ?? null, meta: opts.meta ?? {} })
    .catch(() => {});
}
