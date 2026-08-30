import { asc, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { agents } from "@/core/db/schema/agents";
import {
  flowNodeRuns,
  flowRuns,
  flows,
  type Flow,
  type FlowNodeRun,
  type FlowPayload,
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
  /** The payload that arrived on this node's input wire(s). */
  input: FlowPayload | null;
  /** The real agent_run this node produced (agent nodes) — for the transcript. */
  agentRunId: string | null;
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
  startedAt: number | null;
  finishedAt: number | null;
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
    input: (n.input as FlowPayload | null) ?? null,
    agentRunId: n.agentRunId ?? null,
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
    startedAt: ms(r.startedAt),
    finishedAt: ms(r.finishedAt),
  }));
}

export interface AgentOption {
  id: string;
  name: string;
  /** The agent's allowed tools — its data reach, shown read-only in the node. */
  tools: string[];
  /** The agent's own default model override, if any (shown as the baseline). */
  provider: string | null;
  model: string | null;
}

/** Agents available to drop into an agent node. */
export async function listAgentOptions(): Promise<AgentOption[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      tools: agents.tools,
      provider: agents.provider,
      model: agents.model,
    })
    .from(agents)
    .orderBy(asc(agents.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tools: r.tools ?? [],
    provider: r.provider ?? null,
    model: r.model ?? null,
  }));
}

export interface FlowStats {
  runs: number;
  succeeded: number;
  failed: number;
  /** Mean wall-clock of succeeded runs, ms (null = none yet). */
  avgMs: number | null;
  /** Total agent tokens (in + out) across all this flow's runs. */
  tokens: number;
}

const RUNS_AGG = (whereFlow = dsql``) => dsql`
  select flow_id,
    count(*)::int as runs,
    count(*) filter (where status = 'succeeded')::int as succeeded,
    count(*) filter (where status = 'failed')::int as failed,
    avg(extract(epoch from (finished_at - started_at)) * 1000)
      filter (where status = 'succeeded' and finished_at is not null) as avg_ms
  from flow_runs ${whereFlow}
  group by flow_id`;
const TOKENS_AGG = (whereFlow = dsql``) => dsql`
  select fr.flow_id, coalesce(sum(ar.tokens_in + ar.tokens_out), 0) as tokens
  from flow_runs fr
  join flow_node_runs fnr on fnr.flow_run_id = fr.id
  join agent_runs ar on ar.id = fnr.agent_run_id
  ${whereFlow}
  group by fr.flow_id`;

type RunsRow = { flow_id: string; runs: number; succeeded: number; failed: number; avg_ms: string | null };
type TokRow = { flow_id: string; tokens: string };
const toStats = (r: RunsRow | undefined, tokens: number): FlowStats => ({
  runs: r?.runs ?? 0,
  succeeded: r?.succeeded ?? 0,
  failed: r?.failed ?? 0,
  avgMs: r?.avg_ms != null ? Math.round(Number(r.avg_ms)) : null,
  tokens,
});

/** Aggregate run stats for every flow, keyed by flow id — for the library. */
export async function listFlowStats(): Promise<Map<string, FlowStats>> {
  const [runs, toks] = await Promise.all([
    db.execute<RunsRow>(RUNS_AGG()),
    db.execute<TokRow>(TOKENS_AGG()),
  ]);
  const tok = new Map([...toks].map((r) => [r.flow_id, Number(r.tokens)]));
  const m = new Map<string, FlowStats>();
  for (const r of runs) m.set(r.flow_id, toStats(r, tok.get(r.flow_id) ?? 0));
  return m;
}

/** Aggregate run stats for one flow — for the editor. */
export async function flowStats(flowId: string): Promise<FlowStats> {
  const [runs, toks] = await Promise.all([
    db.execute<RunsRow>(RUNS_AGG(dsql`where flow_id = ${flowId}`)),
    db.execute<TokRow>(TOKENS_AGG(dsql`where fr.flow_id = ${flowId}`)),
  ]);
  return toStats([...runs][0], Number([...toks][0]?.tokens ?? 0));
}

export interface ToolOption {
  name: string;
  description: string;
}

/** Every registered tool, for the Tool/action node's picker. */
export async function listToolOptions(): Promise<ToolOption[]> {
  const { getAllTools } = await import("@/core/ai/tool-registry");
  return getAllTools()
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface FlowOption {
  id: string;
  name: string;
}

/** Other flows available as a loop/sub-routine target (excludes `exceptId`). */
export async function listFlowOptions(exceptId?: string): Promise<FlowOption[]> {
  const rows = await db
    .select({ id: flows.id, name: flows.name })
    .from(flows)
    .orderBy(asc(flows.name));
  return exceptId ? rows.filter((r) => r.id !== exceptId) : rows;
}
