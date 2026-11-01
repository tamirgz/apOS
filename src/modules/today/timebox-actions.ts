"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { requestTimeboxSync } from "@/modules/calendar/timebox-sync";
import { tasks } from "@/modules/tasks/schema";
import { draftDay, endModeFor } from "./draft-day";
import { draftCandidates, draftIdsOn, getPlanDay, ME, parseDay, taskKind } from "./plan";
import { attentionItems, TIMEBOX_KINDS, timeboxes, type TimeboxKind } from "./schema";

/**
 * Writes behind the Plan screen. The user's own day: agents never call these.
 * A draft stays in apOS; any change to a planned box marks it pending and asks
 * the worker to push it to the Timeboxes calendar.
 */

const MIN = 60_000;

async function changed(sync: boolean) {
  await sql.notify("calendar_changed", "timeboxes");
  if (sync) await requestTimeboxSync();
  revalidatePath("/m/today/plan");
  revalidatePath("/m/calendar");
}

/** Boxing an item makes it yours, unless someone else already owns it. */
async function claimForMe(taskId: string) {
  await db
    .update(tasks)
    .set({ assignee: ME, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), isNull(tasks.assignee)));
}

const isKind = (k: unknown): k is TimeboxKind => TIMEBOX_KINDS.includes(k as TimeboxKind);

export async function createBox(input: {
  title?: string;
  startAt: Date;
  minutes: number;
  kind?: TimeboxKind;
  /** "task:<uuid>" | "attention:<uuid>" | undefined for a free-text box. */
  ref?: string;
}) {
  const [refKind, refId] = input.ref?.split(":") ?? [];
  let title = input.title?.trim() ?? "";
  let kind: TimeboxKind = isKind(input.kind) ? input.kind : "personal";
  let taskId: string | null = null;
  let attentionId: string | null = null;

  if (refKind === "task" && refId) {
    const [t] = await db
      .select({ title: tasks.title, shortTitle: tasks.shortTitle, estimate: tasks.estimate })
      .from(tasks)
      .where(eq(tasks.id, refId));
    if (!t) return { error: "That work item no longer exists" };
    taskId = refId;
    title ||= t.shortTitle || t.title;
    if (!isKind(input.kind)) kind = taskKind(t.estimate);
  } else if (refKind === "attention" && refId) {
    const [c] = await db.select({ title: attentionItems.title }).from(attentionItems).where(eq(attentionItems.id, refId));
    if (!c) return { error: "That card no longer exists" };
    attentionId = refId;
    title ||= c.title;
    if (!isKind(input.kind)) kind = "admin";
  }
  if (!title) return { error: "A box needs a title" };
  const minutes = Math.max(15, Math.min(input.minutes, 12 * 60));

  const [box] = await db
    .insert(timeboxes)
    .values({
      title: title.slice(0, 300),
      taskId,
      attentionId,
      startAt: input.startAt,
      endAt: new Date(input.startAt.getTime() + minutes * MIN),
      kind,
      endMode: endModeFor(kind),
      status: "draft",
    })
    .returning({ id: timeboxes.id });
  if (taskId) await claimForMe(taskId);
  await changed(false);
  return { id: box.id };
}

export async function updateBox(
  id: string,
  patch: { startAt?: Date; endAt?: Date; kind?: TimeboxKind; endMode?: "soft" | "hard"; title?: string },
) {
  const [box] = await db.select().from(timeboxes).where(eq(timeboxes.id, id));
  if (!box) return { error: "That box no longer exists" };
  const startAt = patch.startAt ?? box.startAt;
  const endAt = patch.endAt ?? box.endAt;
  if (endAt.getTime() - startAt.getTime() < 15 * MIN) return { error: "A box is at least 15 minutes" };
  const synced = box.status !== "draft";
  await db
    .update(timeboxes)
    .set({
      startAt,
      endAt,
      ...(isKind(patch.kind) ? { kind: patch.kind, ...(patch.endMode ? {} : { endMode: endModeFor(patch.kind) }) } : {}),
      ...(patch.endMode === "soft" || patch.endMode === "hard" ? { endMode: patch.endMode } : {}),
      ...(patch.title?.trim() ? { title: patch.title.trim().slice(0, 300) } : {}),
      ...(synced ? { syncState: "pending" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(timeboxes.id, id));
  await changed(synced);
  return { ok: true };
}

/** A draft is simply removed; a planned box is dropped (kept as history) and leaves Google. */
export async function removeBox(id: string) {
  const [box] = await db.select({ status: timeboxes.status }).from(timeboxes).where(eq(timeboxes.id, id));
  if (!box) return { ok: true };
  if (box.status === "draft") {
    await db.delete(timeboxes).where(eq(timeboxes.id, id));
    await changed(false);
  } else {
    await db
      .update(timeboxes)
      .set({ status: "dropped", syncState: "pending", updatedAt: new Date() })
      .where(eq(timeboxes.id, id));
    await changed(true);
  }
  return { ok: true };
}

/** Fill the day's free time with draft boxes. Nothing already placed moves. */
export async function draftMyDay(date: string) {
  const plan = await getPlanDay(date);
  const day = parseDay(plan.date);
  const drafts = draftDay({
    day,
    now: new Date(),
    settings: plan.settings,
    busy: plan.busy,
    placed: plan.boxes.map((b) => ({ start: b.startAt, end: b.endAt })),
    candidates: draftCandidates(plan),
  });
  if (drafts.length) {
    await db.insert(timeboxes).values(
      drafts.map((d) => {
        const [kind, id] = d.ref.split(":");
        return {
          title: d.title.slice(0, 300),
          taskId: kind === "task" ? id : null,
          attentionId: kind === "attention" ? id : null,
          startAt: d.start,
          endAt: d.end,
          kind: d.kind,
          endMode: d.endMode,
          status: "draft" as const,
        };
      }),
    );
    await changed(false);
  }
  return { drafted: drafts.length };
}

export async function clearDrafts(date: string) {
  const ids = await draftIdsOn(parseDay(date));
  if (ids.length) {
    await db.delete(timeboxes).where(inArray(timeboxes.id, ids));
    await changed(false);
  }
  return { cleared: ids.length };
}

/**
 * Lock the plan: the day's drafts become planned boxes and go to Google.
 * A card that now has a box is done — it's scheduled.
 */
export async function lockPlan(date: string) {
  const ids = await draftIdsOn(parseDay(date));
  if (!ids.length) return { locked: 0 };
  const locked = await db
    .update(timeboxes)
    .set({ status: "planned", syncState: "pending", updatedAt: new Date() })
    .where(and(inArray(timeboxes.id, ids), eq(timeboxes.status, "draft")))
    .returning({ attentionId: timeboxes.attentionId });
  const cards = locked.map((b) => b.attentionId).filter((x): x is string => !!x);
  if (cards.length) {
    await db
      .update(attentionItems)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(inArray(attentionItems.id, cards), eq(attentionItems.status, "open")));
    await sql.notify("attention_changed", "");
  }
  await changed(true);
  return { locked: locked.length };
}

/** ★ — mark a work item as yours, or let it go again. */
export async function toggleMine(taskId: string) {
  const [t] = await db.select({ assignee: tasks.assignee }).from(tasks).where(eq(tasks.id, taskId));
  if (!t) return { error: "That work item no longer exists" };
  const next = t.assignee === ME ? null : ME;
  await db.update(tasks).set({ assignee: next, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await sql.notify("work_changed", "");
  revalidatePath("/m/today/plan");
  return { mine: next === ME };
}
