"use server";

import { revalidatePath } from "next/cache";
import { syncGmail } from "./sync";

/** Pull recent Gmail on demand (button in the UI). */
export async function resyncGmail() {
  const res = await syncGmail();
  revalidatePath("/m/gmail");
  return res;
}

/**
 * Turn a mail into a work item (a todo carrying the Gmail link + snippet).
 * Idempotent per message via externalRef `gmail:<id>` — a second click returns
 * the existing item instead of a duplicate.
 */
export async function mailToWorkItem(messageId: string): Promise<{ id: string; created: boolean }> {
  const [{ db }, { eq }, { gmailMessages }, { tasks }, { createTask }] = await Promise.all([
    import("@/core/db/client"),
    import("drizzle-orm"),
    import("./schema"),
    import("@/modules/tasks/schema"),
    import("@/modules/tasks/actions"),
  ]);
  const ref = `gmail:${messageId}`;
  const [existing] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.externalRef, ref)).limit(1);
  if (existing) return { id: existing.id, created: false };

  const [m] = await db.select().from(gmailMessages).where(eq(gmailMessages.id, messageId)).limit(1);
  if (!m) throw new Error("mail not found — resync and try again");
  const from = m.fromName ?? m.fromEmail ?? "someone";
  const notes = [
    `From ${from}${m.fromEmail && m.fromName ? ` <${m.fromEmail}>` : ""}`,
    m.snippet ? `> ${m.snippet}` : null,
    m.link ? `Open in Gmail: ${m.link}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const item = await createTask({
    title: `Reply: ${m.subject?.trim() || `mail from ${from}`}`,
    notes,
    status: "todo",
    externalRef: ref,
  });
  return { id: item.id, created: true };
}
