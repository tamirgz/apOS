import { asc, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { agents } from "@/core/db/schema/agents";
import {
  flowNodeRuns,
  flowRuns,
  flows,
  type Flow,
  type FlowNodeRun,
  type FlowRun,
} from "@/modules/flows/schema";

export interface FlowCard {
  flow: Flow;
  nodeCount: number;
  agentCount: number;
  lastRun: FlowRun | null;
}

/** Library listing — one row per flow with a shape summary + its last run. */
export async function listFlows(): Promise<FlowCard[]> {
  const [rows, latest] = await Promise.all([
    db.select().from(flows).orderBy(desc(flows.updatedAt)),
    db.execute<FlowRun & { flow_id: string }>(
      dsql`select distinct on (flow_id) * from flow_runs
           order by flow_id, created_at desc`,
    ),
  ]);
  const lastByFlow = new Map(
    [...latest].map((r) => [
      r.flow_id,
      {
        id: r.id,
        flowId: r.flow_id,
        trigger: r.trigger,
        status: r.status,
        startedAt: (r as unknown as { started_at: Date | null }).started_at,
        finishedAt: (r as unknown as { finished_at: Date | null }).finished_at,
        error: r.error,
        createdAt: (r as unknown as { created_at: Date }).created_at,
      } as FlowRun,
    ]),
  );
  return rows.map((flow) => {
    const nodes = flow.graph?.nodes ?? [];
    return {
      flow,
      nodeCount: nodes.length,
      agentCount: nodes.filter((n) => n.kind === "agent").length,
      lastRun: lastByFlow.get(flow.id) ?? null,
    };
  });
}

export async function getFlow(id: string): Promise<Flow | null> {
  const [row] = await db.select().from(flows).where(eq(flows.id, id));
  return row ?? null;
}

export interface RunTrace {
  run: FlowRun;
  nodes: FlowNodeRun[];
}

/** The most recent run of a flow plus its per-node runs — powers live trace. */
export async function latestRunTrace(flowId: string): Promise<RunTrace | null> {
  const [run] = await db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.flowId, flowId))
    .orderBy(desc(flowRuns.createdAt))
    .limit(1);
  if (!run) return null;
  const nodes = await db
    .select()
    .from(flowNodeRuns)
    .where(eq(flowNodeRuns.flowRunId, run.id))
    .orderBy(asc(flowNodeRuns.startedAt));
  return { run, nodes };
}

export interface AgentOption {
  id: string;
  name: string;
}

/** Agents available to drop into an agent node. */
export async function listAgentOptions(): Promise<AgentOption[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .orderBy(asc(agents.name));
  return rows;
}
