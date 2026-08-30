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
    db.execute<{ key: string; value: string }>(
      dsql`select key, value from app_settings where key like 'agent_gate_last:%'`,
    ),
  ]);
  const gateByAgent = new Map<string, { at: string; run: boolean; reason: string }>();
  for (const r of gateRows) {
    try {
      gateByAgent.set(r.key.slice("agent_gate_last:".length), JSON.parse(r.value));
    } catch {
      // malformed trace — ignore
    }
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
