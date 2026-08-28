/**
 * Failure alerting — make major faults NOISY instead of silent.
 *
 * A scheduled agent run or a background job that fails used to only set a status
 * / log a line, so a persistent breakage (a stuck agent, an expired token) could
 * run silent for days. This raises a bell + Slack notification AND a self-closing
 * "Needs you" card on the FAILING TRANSITION — the first time something starts
 * failing — and clears both when it next succeeds. Transition-based, so a
 * persistent failure alerts once (not every run), and nothing is missed.
 *
 * Every function here is best-effort and swallows its own errors: alerting must
 * never change the outcome of the thing it is observing.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import { agentRuns } from "@/core/db/schema/agents";
import { attentionItems } from "@/modules/today/schema";
import { getSetting, setSetting } from "@/core/app-settings";
import { notify } from "@/core/notify";

const FAIL_STATUSES = ["failed", "timed_out"];

/** Raise a self-closing "Needs you" card, idempotent on an explicit dedupeKey
 *  (one open card per key — no semantic dedupe, so distinct subjects never
 *  collapse into one). No-op if a card for this key is already open. */
async function raiseCard(opts: {
  dedupeKey: string;
  title: string;
  body: string;
  urgency: number;
  href: string;
}) {
  const [open] = await db
    .select({ id: attentionItems.id })
    .from(attentionItems)
    .where(and(eq(attentionItems.dedupeKey, opts.dedupeKey), eq(attentionItems.status, "open")))
    .limit(1);
  if (open) return;
  await db.insert(attentionItems).values({
    type: "notify",
    title: opts.title,
    body: opts.body,
    source: "system",
    urgency: opts.urgency,
    href: opts.href,
    dedupeKey: opts.dedupeKey,
  });
  await sql.notify("attention_changed", "");
}

/** Close any open card for a dedupeKey (recovery). */
async function clearCard(dedupeKey: string) {
  await db
    .update(attentionItems)
    .set({ status: "done" })
    .where(and(eq(attentionItems.dedupeKey, dedupeKey), eq(attentionItems.status, "open")));
  await sql.notify("attention_changed", "");
}

/**
 * Report an agent run's terminal outcome. Alerts on the transition INTO failing
 * (previous terminal run wasn't a failure) for scheduled (cron) runs; clears the
 * alert on the transition back to success. Manual runs never alert (the user is
 * watching), but a manual success still clears a standing cron-failure alert.
 */
export async function reportAgentRunOutcome(opts: {
  agent: { id: string; name: string };
  runId: string;
  trigger: string;
  status: string;
  error?: string | null;
}): Promise<void> {
  const { agent, runId, trigger, status, error } = opts;
  try {
    const [prev] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.agentId, agent.id),
          ne(agentRuns.id, runId),
          inArray(agentRuns.status, ["failed", "timed_out", "succeeded"]),
        ),
      )
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    const isFail = FAIL_STATUSES.includes(status);
    const wasFail = prev ? FAIL_STATUSES.includes(prev.status) : false;
    const key = `agentfail:${agent.id}`;
    const title = `Agent “${agent.name}” is failing`;

    if (isFail && !wasFail && trigger === "cron") {
      const body = (error ?? "").slice(0, 300);
      await notify({
        title,
        body,
        level: "warn",
        source: `agent:${agent.name}`,
        href: "/m/agents",
      });
      await raiseCard({
        dedupeKey: key,
        title,
        body: `${body}\nAuto-clears when the agent next succeeds.`,
        urgency: 16,
        href: "/m/agents",
      });
    } else if (!isFail && wasFail) {
      await clearCard(key);
      await notify({
        title: `Agent “${agent.name}” recovered`,
        level: "success",
        source: `agent:${agent.name}`,
        href: "/m/agents",
      });
    }
  } catch {
    /* alerting is best-effort — never affect the run */
  }
}

/**
 * Report a background job's outcome. State is kept per channel in app_settings
 * (`job_health:<channel>`), so a persistent failure alerts once and clears on
 * the next success. Call with ok=true after every successful run and ok=false
 * (plus the error) when the handler throws.
 */
export async function reportJobOutcome(
  channel: string,
  ok: boolean,
  error?: unknown,
): Promise<void> {
  try {
    const stateKey = `job_health:${channel}`;
    const prev = (await getSetting(stateKey)) ?? "ok";
    const key = `jobfail:${channel}`;
    const title = `Background job “${channel}” is failing`;

    if (!ok && prev !== "failing") {
      await setSetting(stateKey, "failing");
      const body = String(error ?? "").slice(0, 300);
      await notify({
        title,
        body,
        level: "warn",
        source: `job:${channel}`,
        href: "/m/settings/connections",
      });
      await raiseCard({
        dedupeKey: key,
        title,
        body: `${body}\nAuto-clears when the job next succeeds.`,
        urgency: 14,
        href: "/m/settings/connections",
      });
    } else if (ok && prev === "failing") {
      await setSetting(stateKey, "ok");
      await clearCard(key);
      await notify({
        title: `Background job “${channel}” recovered`,
        level: "success",
        source: `job:${channel}`,
        href: "/m/settings/connections",
      });
    }
  } catch {
    /* best-effort */
  }
}
