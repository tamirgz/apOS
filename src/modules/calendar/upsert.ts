import { or, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { calendarEvents } from "./schema";

type EventRow = typeof calendarEvents.$inferInsert;
type Field = Exclude<keyof EventRow, "id" | "icsUid" | "createdAt" | "updatedAt">;

const BATCH = 500;

/**
 * Upsert synced events on `ics_uid`, a batch per statement. The syncs used to
 * write every event one round trip at a time every 5 minutes, and bump its
 * updated_at even when nothing changed (~3M single-row inserts in two months).
 * Now an event whose `fields` all match is left alone. Returns how many rows
 * were inserted or changed, so the caller can skip telling the UI when none were.
 */
export async function upsertSyncedEvents(rows: EventRow[], fields: Field[]): Promise<number> {
  // One statement can't touch the same row twice: the last copy of a uid wins.
  const byUid = new Map(rows.map((r) => [r.icsUid, r]));
  const unique = [...byUid.values()];
  if (!unique.length) return 0;
  const set: Record<string, unknown> = { updatedAt: dsql`now()` };
  for (const f of fields) set[f] = dsql.raw(`excluded."${calendarEvents[f].name}"`);
  const changed = or(
    ...fields.map((f) => {
      const c = calendarEvents[f].name;
      return dsql.raw(`calendar_events."${c}" is distinct from excluded."${c}"`);
    }),
  );
  let n = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    const written = await db
      .insert(calendarEvents)
      .values(unique.slice(i, i + BATCH))
      .onConflictDoUpdate({ target: calendarEvents.icsUid, set, setWhere: changed })
      .returning({ id: calendarEvents.id });
    n += written.length;
  }
  return n;
}
