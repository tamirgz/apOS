"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { calendarEvents } from "./schema";

export async function createEvent(input: {
  title: string;
  startAt: Date;
  endAt?: Date | null;
  allDay?: boolean;
  notes?: string;
}) {
  const title = input.title.trim();
  if (!title) throw new Error("event title required");
  const [row] = await db
    .insert(calendarEvents)
    .values({
      title,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      allDay: input.allDay ?? false,
      notes: input.notes?.trim() || null,
    })
    .returning();
  await sql.notify("calendar_changed", row.id);
  revalidatePath("/m/calendar");
  revalidatePath("/");
  return row;
}

export async function updateEvent(
  id: string,
  patch: {
    title: string;
    startAt: Date;
    endAt?: Date | null;
    allDay?: boolean;
    location?: string | null;
    notes?: string | null;
  },
) {
  const title = patch.title.trim();
  if (!title) throw new Error("event title required");
  if (patch.endAt && patch.endAt < patch.startAt) {
    throw new Error("event can't end before it starts");
  }
  // Only apOS-local events are editable — google/ics rows are overwritten by
  // the next sync, so an edit there would silently vanish. The WHERE enforces
  // it even if a stale UI offers the button.
  const { and } = await import("drizzle-orm");
  const [row] = await db
    .update(calendarEvents)
    .set({
      title,
      startAt: patch.startAt,
      endAt: patch.endAt ?? null,
      allDay: patch.allDay ?? false,
      location: patch.location?.trim() || null,
      notes: patch.notes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(and(eq(calendarEvents.id, id), eq(calendarEvents.source, "local")))
    .returning({ id: calendarEvents.id });
  if (!row) throw new Error("only apOS-created events can be edited here");
  await sql.notify("calendar_changed", id);
  revalidatePath("/m/calendar");
  revalidatePath("/");
}

export async function deleteEvent(id: string) {
  await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
  await sql.notify("calendar_changed", id);
  revalidatePath("/m/calendar");
  revalidatePath("/");
}

export async function requestIcsSync() {
  await sql.notify("calendar_sync", "manual");
}
