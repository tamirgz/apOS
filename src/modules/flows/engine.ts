/**
 * The Flow Engine — a graph interpreter that ORCHESTRATES existing primitives.
 * It walks a flow's graph, runs each node, and passes one node's output into the
 * next along its wires. Agent nodes run as REAL agent_runs (reusing the executor
 * unchanged), so their tools, model routing, memory and self-learning all apply;
 * the flow just decides who runs, in what order, on whose result.
 *
 * Phase 1 executes linear chains (a node has at most one input). Branch /
 * fan-out / merge / human are stubbed as pass-through and land in later phases.
 */
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { agentRuns } from "@/core/db/schema/agents";
import { executeRun } from "@/worker/executor";
import {
  flowNodeRuns,
  flowRuns,
  flows,
  type FlowGraph,
  type FlowNode,
  type FlowPayload,
} from "./schema";

const log = (m: string) => console.log(`[flow ${new Date().toISOString()}] ${m}`);

/** Run a flow once. Returns the flow_run id (or null if the flow is missing). */
export async function runFlow(
  flowId: string,
  trigger = "manual",
): Promise<string | null> {
  const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
  if (!flow) return null;
  const [run] = await db
    .insert(flowRuns)
    .values({ flowId, trigger, status: "running", startedAt: new Date() })
    .returning();
  log(`▶ "${flow.name}" run ${run.id}`);
  try {
    await executeGraph(flow.graph, run.id);
    await db
      .update(flowRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(flowRuns.id, run.id));
    log(`✔ "${flow.name}" run ${run.id} succeeded`);
  } catch (e) {
    await db
      .update(flowRuns)
      .set({ status: "failed", error: String(e).slice(0, 500), finishedAt: new Date() })
      .where(eq(flowRuns.id, run.id));
    log(`✘ "${flow.name}" run ${run.id} failed: ${e}`);
    // Flow-scope alert — reuse the transition-based failure alerting.
    try {
      const { reportJobOutcome } = await import("@/core/alerts");
      await reportJobOutcome(`flow:${flow.name}`, false, e);
    } catch {
      /* best-effort */
    }
  }
  return run.id;
}

/** Walk the DAG: a node runs once all its inputs are ready; its output flows on. */
async function executeGraph(graph: FlowGraph, flowRunId: string): Promise<void> {
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const n of nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      incoming.get(e.to)!.push(e.from);
      outgoing.get(e.from)!.push(e.to);
    }
  }
  const outputs = new Map<string, FlowPayload | null>();
  const done = new Set<string>();
  const queue = nodes.filter((n) => incoming.get(n.id)!.length === 0).map((n) => n.id);
  let guard = 0;

  while (queue.length) {
    if (++guard > nodes.length * 4 + 20) throw new Error("flow did not converge (cycle?)");
    const id = queue.shift()!;
    if (done.has(id)) continue;
    const sources = incoming.get(id)!;
    if (sources.some((s) => !done.has(s))) {
      queue.push(id); // inputs not ready yet — revisit
      continue;
    }
    const node = byId.get(id)!;
    const input = sources.length ? outputs.get(sources[0]) ?? null : null;
    const output = await runNode(node, input, flowRunId);
    outputs.set(id, output);
    done.add(id);
    for (const to of outgoing.get(id)!) if (!done.has(to)) queue.push(to);
  }
}

async function runNode(
  node: FlowNode,
  input: FlowPayload | null,
  flowRunId: string,
): Promise<FlowPayload | null> {
  const [nr] = await db
    .insert(flowNodeRuns)
    .values({
      flowRunId,
      nodeId: node.id,
      kind: node.kind,
      status: "running",
      input: input ?? null,
      startedAt: new Date(),
    })
    .returning();
  try {
    let output: FlowPayload | null = input;
    if (node.kind === "trigger") output = { from: node.name ?? "trigger" };
    else if (node.kind === "agent") output = await runAgentNode(node, input, nr.id);
    else if (node.kind === "output" || node.kind === "tool")
      output = await runOutputNode(node, input);
    // Other kinds (branch/fanout/merge/…) pass through in Phase 1.
    await db
      .update(flowNodeRuns)
      .set({ status: "succeeded", output: output ?? null, finishedAt: new Date() })
      .where(eq(flowNodeRuns.id, nr.id));
    return output;
  } catch (e) {
    await db
      .update(flowNodeRuns)
      .set({ status: "failed", error: String(e).slice(0, 500), finishedAt: new Date() })
      .where(eq(flowNodeRuns.id, nr.id));
    throw e;
  }
}

/** Run an agent node as a real agent_run, handing it the upstream payload. */
async function runAgentNode(
  node: FlowNode,
  input: FlowPayload | null,
  nodeRunId: string,
): Promise<FlowPayload> {
  const agentId = node.config?.agentId as string | undefined;
  if (!agentId)
    throw new Error("agent node has no agentId (inline agent configs land in a later phase)");
  // A flow-triggered agent run, linked back to this node run so the executor
  // injects the upstream payload + exposes flow.emit.
  const [ar] = await db
    .insert(agentRuns)
    .values({ agentId, trigger: "flow", status: "queued", flowNodeRunId: nodeRunId })
    .returning();
  await db.update(flowNodeRuns).set({ agentRunId: ar.id }).where(eq(flowNodeRuns.id, nodeRunId));
  await executeRun(ar.id);
  const [finished] = await db.select().from(agentRuns).where(eq(agentRuns.id, ar.id));
  if (finished.status !== "succeeded")
    throw new Error(`agent "${node.name ?? agentId}" ${finished.status}: ${finished.error ?? ""}`);
  const [nr] = await db.select().from(flowNodeRuns).where(eq(flowNodeRuns.id, nodeRunId));
  return {
    report: finished.result ?? "",
    signal: (nr?.signal as Record<string, unknown> | null) ?? null,
    from: node.name ?? "agent",
  };
}

/** Terminal delivery — write the upstream result to a surface. */
async function runOutputNode(
  node: FlowNode,
  input: FlowPayload | null,
): Promise<FlowPayload | null> {
  const tool = (node.config?.tool as string) || "notify";
  const report =
    input?.report ?? (typeof input === "string" ? input : JSON.stringify(input ?? {}));
  if (tool === "notify") {
    const { notify } = await import("@/core/notify");
    await notify({
      title: node.name || "Flow result",
      body: String(report).slice(0, 1500),
      source: "flow",
      level: "info",
    });
  }
  // attention.raise / other write tools land in a later phase.
  return input;
}
