import { desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import {
  agentRuns,
  agents,
  type Agent,
  type AgentRun,
} from "@/core/db/schema/agents";

export interface AgentWithLatestRun {
  agent: Agent;
  latestRun: AgentRun | null;
  /** The last cron pre-flight decision (agent-gates) — null before any fire. */
  gateLast: { at: string; run: boolean; reason: string } | null;
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
  }));
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
