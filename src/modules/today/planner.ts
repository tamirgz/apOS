/**
 * Deterministic day planner. Replaces the old LLM "Daily planner" agent, which
 * would succeed every run yet never call `attention.raise` (a coding model
 * rabbit-holing into prose) — so "Needs you" sat empty for days with no signal.
 *
 * This computes the cards from real state in SQL — projects that need attention,
 * overdue and high-priority tasks — and raises them directly through the same
 * `insertAttentionItem` path (auto-dedup, so a re-run is a no-op for still-valid
 * cards). It also RECONCILES: an open card it raised whose signal is gone (task
 * done, project recovered) is closed, so the queue always reflects reality.
 *
 * Runs as a worker job (`today.plan`), so `runJob`'s reportJobOutcome makes any
 * breakage LOUD — it can never fail silently the way the agent did.
 */
import { and, eq, inArray, isNotNull, lt, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { projects } from "@/modules/projects/schema";
import { tasks } from "@/modules/tasks/schema";
import { attentionItems } from "./schema";
import { deriveDedupeKey, insertAttentionItem, normalizeRef, type RaiseInput } from "./core";

const SOURCE = "today-plan";
/** Health values that mean a project needs the user's eyes. */
const NEEDS_EYES = ["blocked", "stalled", "at_risk"] as const;
const HEALTH_URGENCY: Record<string, number> = { blocked: 60, stalled: 48, at_risk: 38 };

export async function planDay(): Promise<{ raised: number; closed: number }> {
  const desired: RaiseInput[] = [];

  // 1) Active PROJECTS (not standing areas) whose health needs attention.
  const risky = await db
    .select({ id: projects.id, name: projects.name, health: projects.health, nextAction: projects.nextAction })
    .from(projects)
    .where(
      and(
        eq(projects.status, "active"),
        eq(projects.kind, "project"),
        inArray(projects.health, [...NEEDS_EYES]),
      ),
    );
  for (const p of risky) {
    desired.push({
      type: "do",
      title: `${p.name} is ${String(p.health).replace("_", " ")}`,
      body: p.nextAction ? `Next action: ${p.nextAction}` : "No next action set — decide the next step.",
      projectRef: `projects:${p.id}`,
      trustProjectRef: true,
      urgency: HEALTH_URGENCY[p.health ?? ""] ?? 35,
      href: `/m/projects/${p.id}`,
      source: SOURCE,
    });
  }

  // 2) Overdue open tasks — the most overdue first.
  const overdue = await db
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, projectRef: tasks.projectRef })
    .from(tasks)
    .where(and(inArray(tasks.status, ["todo", "doing"]), isNotNull(tasks.dueAt), lt(tasks.dueAt, new Date())))
    .orderBy(tasks.dueAt)
    .limit(3);
  for (const t of overdue) {
    desired.push({
      type: "do",
      title: t.title,
      body: t.dueAt ? `Overdue since ${t.dueAt.toISOString().slice(0, 10)}.` : "Overdue.",
      projectRef: t.projectRef ?? null,
      trustProjectRef: true,
      urgency: 55,
      dueAt: t.dueAt,
      href: `/m/tasks/${t.id}`,
      source: SOURCE,
    });
  }

  // 3) High-priority open tasks due TODAY (not already overdue).
  const dueToday = await db
    .select({ id: tasks.id, title: tasks.title, projectRef: tasks.projectRef })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["todo", "doing"]),
        eq(tasks.priority, "high"),
        isNotNull(tasks.dueAt),
        dsql`${tasks.dueAt}::date = now()::date`,
        dsql`${tasks.dueAt} >= now()`,
      ),
    )
    .limit(2);
  for (const t of dueToday) {
    desired.push({
      type: "do",
      title: t.title,
      body: "High priority, due today.",
      projectRef: t.projectRef ?? null,
      trustProjectRef: true,
      urgency: 45,
      href: `/m/tasks/${t.id}`,
      source: SOURCE,
    });
  }

  // 4) Email needing attention (the third leg of ONE-STOP §2.3's "one brief"):
  // unread messages Google marked IMPORTANT or STARRED that have sat for over
  // a day. One rollup card — never per-mail spam. The count is in the title,
  // so when it changes the reconcile pass swaps the card; at zero it closes.
  try {
    const mailRows = await db.execute<{ n: number }>(dsql`
      select count(*)::int as n from gmail_messages
       where unread and received_at < now() - interval '1 day'
         and labels && array['IMPORTANT','STARRED']`);
    const n = Number([...mailRows][0]?.n ?? 0);
    if (n > 0) {
      desired.push({
        type: "do",
        title: `${n} important email${n === 1 ? "" : "s"} waiting`,
        body: "Unread and marked important/starred for more than a day.",
        urgency: 40,
        href: "/m/gmail",
        source: SOURCE,
      });
    }
  } catch {
    // gmail table empty/not synced — the planner never fails on mail
  }

  // Surface the vital few, most-urgent first.
  desired.sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0));
  const top = desired.slice(0, 5);

  // Reconcile: close any open card WE raised whose signal is no longer present.
  const wantedKeys = new Set(
    top.map((d) =>
      deriveDedupeKey({
        projectRef: normalizeRef(d.projectRef, "projects"),
        personRef: null,
        title: d.title,
      }),
    ),
  );
  const openPlan = await db
    .select({ id: attentionItems.id, dedupeKey: attentionItems.dedupeKey })
    .from(attentionItems)
    .where(and(eq(attentionItems.source, SOURCE), eq(attentionItems.status, "open")));
  let closed = 0;
  for (const c of openPlan) {
    if (!c.dedupeKey || !wantedKeys.has(c.dedupeKey)) {
      await db.update(attentionItems).set({ status: "done" }).where(eq(attentionItems.id, c.id));
      closed++;
    }
  }

  // Raise the current cards (insertAttentionItem dedups → still-valid cards are no-ops).
  let raised = 0;
  for (const d of top) {
    await insertAttentionItem(d);
    raised++;
  }
  if (raised || closed) await sql.notify("attention_changed", "");
  return { raised, closed };
}
