import { Cron } from "croner";
import { desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import {
  agentRuns,
  agents,
  type Agent,
  type AgentRun,
} from "@/core/db/schema/agents";
import { chatRuns } from "@/core/db/schema/chat-runs";
import { RUN_CONCURRENCY } from "@/worker/run-queue";

export interface AgentWithLatestRun {
  agent: Agent;
  latestRun: AgentRun | null;
  /** The last cron pre-flight decision (agent-gates) — null before any fire. */
  gateLast: { at: string; run: boolean; reason: string } | null;
  /** Next scheduled fire (ISO), from the cron pattern. Null = manual-only,
   *  disabled, or an unparseable schedule. */
  nextRunAt: string | null;
}

/** Next fire of a cron pattern as ISO, or null (manual/disabled/invalid). */
function nextFire(schedule: string | null, enabled: boolean): string | null {
  if (!schedule || !enabled) return null;
  try {
    return new Cron(schedule).nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  }
}

export async function listAgentsWithLatestRun(): Promise<AgentWithLatestRun[]> {
  // Three queries total regardless of agent count (was one per agent).
  const [all, latest, gateRows] = await Promise.all([
    db.select().from(agents).orderBy(desc(agents.createdAt)),
    db.execute<AgentRun & { agent_id: string }>(
      dsql`select distinct on (agent_id) * from agent_runs
           order by agent_id, created_at desc`,
    ),
    // Latest gate verdict per agent — read from the audit trail (the single
    // source of truth for agent decisions).
    db.execute<{ agent_id: string; event: string; detail: { reason?: string } | null; created_at: Date }>(
      dsql`select distinct on (agent_id) agent_id::text, event, detail, created_at
             from agent_audit
            where event in ('gate.run','gate.skip') and agent_id is not null
            order by agent_id, created_at desc`,
    ),
  ]);
  const gateByAgent = new Map<string, { at: string; run: boolean; reason: string }>();
  for (const r of gateRows) {
    gateByAgent.set(r.agent_id, {
      at: new Date(r.created_at).toISOString(),
      run: r.event === "gate.run",
      reason: r.detail?.reason ?? "",
    });
  }
  const latestByAgent = new Map(
    [...latest].map((r) => [
      r.agent_id,
      {
        id: r.id,
        agentId: r.agent_id,
        status: r.status,
        trigger: r.trigger,
        startedAt: (r as unknown as { started_at: Date | null }).started_at,
        finishedAt: (r as unknown as { finished_at: Date | null }).finished_at,
        heartbeatAt: (r as unknown as { heartbeat_at: Date | null }).heartbeat_at,
        transcript: r.transcript,
        result: r.result,
        error: r.error,
        tokensIn: (r as unknown as { tokens_in: number }).tokens_in,
        tokensOut: (r as unknown as { tokens_out: number }).tokens_out,
        createdAt: (r as unknown as { created_at: Date }).created_at,
      } as AgentRun,
    ]),
  );
  return all.map((agent) => ({
    agent,
    latestRun: latestByAgent.get(agent.id) ?? null,
    gateLast: gateByAgent.get(agent.id) ?? null,
    nextRunAt: nextFire(agent.schedule, agent.enabled),
  }));
}

export interface RunQueueEntry {
  runId: string;
  /** Agent name, or the chat prompt's title. */
  label: string;
  /** internally-initiated (agent/cron/flow) vs externally-initiated (a prompt). */
  kind: "agent" | "chat";
  /** Agent detail link; chat runs have no dedicated page. */
  href: string | null;
  status: "running" | "queued";
  /** cron/manual/flow for agents; the route (⌘K / investments / ask) for chats. */
  trigger: string;
  createdAt: string;
  startedAt: string | null;
}

const CHAT_TRIGGER: Record<string, string> = {
  chat: "⌘K",
  "chat.investments": "investments",
  ask: "ask",
};

export interface RunQueueState {
  /** Admission cap (AIOS_AGENT_RUN_CONCURRENCY) — the governance policy. */
  capacity: number;
  /** In-flight runs: `running` = admitted + executing, `queued` = waiting for a
   *  slot (or not yet picked up). Running first, then queued FIFO. */
  entries: RunQueueEntry[];
}

/**
 * The live admission queue, as the DB mirrors it. The worker's semaphore is
 * in-memory (another process), but its rule — acquire the slot BEFORE the
 * queued→running claim — means `agent_runs.status` is an accurate reflection:
 * at most `capacity` rows are `running`, the rest wait as `queued`.
 */
export async function getRunQueue(): Promise<RunQueueState> {
  // Agents (internally-initiated) + chat prompts (externally-initiated) share
  // one queue view. Two cheap queries, merged and ordered in JS.
  const [agentRows, chatRows] = await Promise.all([
    db
      .select({
        runId: agentRuns.id,
        agentId: agentRuns.agentId,
        agentName: agents.name,
        status: agentRuns.status,
        trigger: agentRuns.trigger,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
      })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(inArray(agentRuns.status, ["running", "queued"])),
    db
      .select({
        runId: chatRuns.id,
        title: chatRuns.title,
        taskKey: chatRuns.taskKey,
        status: chatRuns.status,
        createdAt: chatRuns.createdAt,
        startedAt: chatRuns.startedAt,
      })
      .from(chatRuns)
      .where(inArray(chatRuns.status, ["running", "queued"])),
  ]);

  const entries: RunQueueEntry[] = [
    ...agentRows.map((r) => ({
      runId: r.runId,
      label: r.agentName,
      kind: "agent" as const,
      href: `/m/agents/${r.agentId}`,
      status: r.status as "running" | "queued",
      trigger: r.trigger,
      createdAt: new Date(r.createdAt).toISOString(),
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    })),
    ...chatRows.map((r) => ({
      runId: r.runId,
      label: r.title,
      kind: "chat" as const,
      href: null,
      status: r.status as "running" | "queued",
      trigger: CHAT_TRIGGER[r.taskKey] ?? "chat",
      createdAt: new Date(r.createdAt).toISOString(),
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    })),
  ].sort((a, b) => {
    // Running first, then queued; within each, oldest first (FIFO).
    const rank = (s: string) => (s === "running" ? 0 : 1);
    return rank(a.status) - rank(b.status) || a.createdAt.localeCompare(b.createdAt);
  });

  return { capacity: RUN_CONCURRENCY, entries };
}

export async function getAgent(id: string): Promise<Agent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row ?? null;
}

export async function listAgentAudit(agentId: string, limit = 60) {
  const { agentAudit } = await import("@/core/db/schema/agents");
  return db
    .select()
    .from(agentAudit)
    .where(eq(agentAudit.agentId, agentId))
    .orderBy(desc(agentAudit.createdAt))
    .limit(limit);
}

export async function listRuns(agentId: string, limit = 20) {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}

export async function listRecentRunsAcrossAgents(limit = 5) {
  return db
    .select({
      run: agentRuns,
      agentName: dsql<string>`(select ${agents.name} from ${agents} where ${agents.id} = ${agentRuns.agentId})`,
    })
    .from(agentRuns)
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}
