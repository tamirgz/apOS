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

/** A per-node run, flattened for the client (dates → epoch ms, report lifted). */
export interface NodeRunView {
  nodeId: string;
  kind: string;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** Emitted signal / a branch's chosen port ({ chose, truthy }). */
  signal: Record<string, unknown> | null;
  report: string | null;
  error: string | null;
}
export interface RunView {
  runId: string;
  status: string;
  trigger: string;
  startedAt: number | null;
  finishedAt: number | null;
  nodes: NodeRunView[];
}
export interface RunMeta {
  id: string;
  status: string;
  trigger: string;
  createdAt: number;
}

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);

function toNodeView(n: FlowNodeRun): NodeRunView {
  const out = n.output as { report?: string } | null;
  return {
    nodeId: n.nodeId,
    kind: n.kind,
    status: n.status,
    startedAt: ms(n.startedAt),
    finishedAt: ms(n.finishedAt),
    signal: (n.signal as Record<string, unknown> | null) ?? null,
    report: out?.report ?? null,
    error: n.error ?? null,
  };
}

/** One run + its per-node runs, flattened for the canvas trace panel. */
export async function runView(runId: string): Promise<RunView | null> {
  const [run] = await db.select().from(flowRuns).where(eq(flowRuns.id, runId));
  if (!run) return null;
  const nodes = await db
    .select()
    .from(flowNodeRuns)
    .where(eq(flowNodeRuns.flowRunId, run.id))
    .orderBy(asc(flowNodeRuns.startedAt));
  return {
    runId: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: ms(run.startedAt),
    finishedAt: ms(run.finishedAt),
    nodes: nodes.map(toNodeView),
  };
}

/** The most recent run of a flow — powers the live trace on load. */
export async function latestRunView(flowId: string): Promise<RunView | null> {
  const [run] = await db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(eq(flowRuns.flowId, flowId))
    .orderBy(desc(flowRuns.createdAt))
    .limit(1);
  return run ? runView(run.id) : null;
}

/** Recent runs of a flow (metadata only) for the run picker. */
export async function listRecentRuns(flowId: string, limit = 8): Promise<RunMeta[]> {
  const rows = await db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.flowId, flowId))
    .orderBy(desc(flowRuns.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    createdAt: ms(r.createdAt) ?? 0,
  }));
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
