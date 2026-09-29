"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { recordUsage } from "@/core/usage";
import { createEvent } from "@/modules/calendar/actions";
import { insertAttentionItem, type RaiseInput } from "./core";
import { attentionItems, type AttentionStatus } from "./schema";

function revalidate() {
  revalidatePath("/");
  revalidatePath("/m/today");
}

/** NOTIFY so the queue + widgets refresh live. */
async function ping() {
  await sql.notify("attention_changed", "");
}

/**
 * Raise an attention item — the one write path agents and the system use.
 * Idempotent on a content key (project + person + title): if an OPEN card for
 * the same thing exists, this is a no-op, so a re-running agent — or a
 * different agent raising the same item — never stacks a duplicate nudge.
 */
export async function raiseAttention(input: RaiseInput) {
  const row = await insertAttentionItem(input);
  revalidate();
  return row;
}

async function setStatus(id: string, status: AttentionStatus) {
  const [card] = await db
    .update(attentionItems)
    .set({ status, updatedAt: new Date() })
    .where(eq(attentionItems.id, id))
    .returning({ source: attentionItems.source, type: attentionItems.type });
  recordUsage(`attention.${status}`, {
    entityRef: `attention:${id}`,
    meta: { source: card?.source, type: card?.type },
  });
  await ping();
  revalidate();
}

export async function doneAttention(id: string) {
  await setStatus(id, "done");
}
export async function dismissAttention(id: string) {
  await setStatus(id, "dismissed");
}

/** Snooze until a time; a sweep re-opens it when the time passes. */
export async function snoozeAttention(id: string, until: Date) {
  await db
    .update(attentionItems)
    .set({ status: "snoozed", snoozedUntil: until, updatedAt: new Date() })
    .where(eq(attentionItems.id, id));
  recordUsage("attention.snoozed", { entityRef: `attention:${id}` });
  await ping();
  revalidate();
}

/** The single next physical step for a project (GTD atom). */
export async function setProjectNextAction(
  projectId: string,
  nextAction: string | null,
) {
  const { projects } = await import("@/modules/projects/schema");
  await db
    .update(projects)
    .set({ nextAction: nextAction?.trim() || null, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  revalidatePath("/m/today");
  revalidatePath(`/m/projects/${projectId}`);
}

/**
 * Accept a plan block onto the real calendar — the Plan-my-day write-back.
 * A local apOS event (source "local"), one hour by default. This is a `do`
 * action the user takes explicitly, so no approval gate is needed.
 */
export async function scheduleBlock(input: {
  title: string;
  startAt: Date;
  minutes?: number;
  notes?: string;
  attentionId?: string;
}) {
  const endAt = new Date(input.startAt.getTime() + (input.minutes ?? 60) * 60_000);
  await createEvent({
    title: input.title,
    startAt: input.startAt,
    endAt,
    notes: input.notes,
  });
  // If this block came from an attention card, close it — it's now scheduled.
  if (input.attentionId) await setStatus(input.attentionId, "done");
  revalidatePath("/m/today");
}

