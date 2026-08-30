"use server";

import { Cron } from "croner";
import { and, eq, sql as dsql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { agents, agentRuns } from "@/core/db/schema/agents";
import {
  flowNodeRuns,
  flowRuns,
  flows,
  type FlowGraph,
  type FlowTrigger,
} from "@/modules/flows/schema";
import { createAgent } from "@/modules/agents/actions";
import { runView, type AgentOption, type RunView } from "./queries";
import { sanitizeFlowGraph } from "./graph";
import { templateById } from "./templates";

const uid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function touched(id?: string) {
  await sql.notify("flows_changed", id ?? "");
  revalidatePath("/m/studio");
  if (id) revalidatePath(`/m/studio/${id}`);
}

/** Create an empty flow (just a trigger) and return its id for navigation. */
export async function createFlow(name?: string): Promise<string> {
  const graph: FlowGraph = {
    nodes: [{ id: uid("trigger"), kind: "trigger", name: "Start", x: 120, y: 160 }],
    edges: [],
  };
  const [row] = await db
    .insert(flows)
    .values({ name: name?.trim() || "Untitled flow", graph })
    .returning();
  await touched(row.id);
  return row.id;
}

/** Create a new flow from a built-in template. */
export async function createFlowFromTemplate(templateId: string): Promise<string> {
  const tpl = templateById(templateId);
  if (!tpl) throw new Error("unknown template");
  const graph = JSON.parse(JSON.stringify(tpl.graph)) as FlowGraph; // clone
  const [row] = await db
    .insert(flows)
    .values({ name: tpl.name, description: tpl.description, graph })
    .returning();
  await touched(row.id);
  return row.id;
}

/** Import a flow from exported JSON. Validates + sanitizes the graph shape. */
export async function importFlow(payload: unknown): Promise<string> {
  const p = payload as { name?: unknown; description?: unknown; graph?: unknown } | null;
  const graph = sanitizeFlowGraph(p?.graph);
  if (!graph) throw new Error("not a valid flow file (missing nodes/edges)");
  const name = typeof p?.name === "string" && p.name.trim() ? p.name.trim() : "Imported flow";
  const description = typeof p?.description === "string" ? p.description : null;
  const [row] = await db.insert(flows).values({ name, description, graph }).returning();
  await touched(row.id);
  return row.id;
}

/** Turn an existing agent into a one-node flow: trigger → agent → output. */
export async function importAgentAsFlow(agentId: string): Promise<string> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new Error("agent not found");
  const t = uid("trigger");
  const a = uid("agent");
  const o = uid("output");
  const graph: FlowGraph = {
    nodes: [
      { id: t, kind: "trigger", name: "Start", x: 100, y: 170 },
      { id: a, kind: "agent", name: agent.name, x: 360, y: 170, config: { agentId } },
      { id: o, kind: "output", name: "Notify", x: 620, y: 170, config: { tool: "notify" } },
    ],
    edges: [
      { id: uid("e"), from: t, to: a },
      { id: uid("e"), from: a, to: o },
    ],
  };
  const [row] = await db
    .insert(flows)
    .values({ name: agent.name, description: `Imported from agent "${agent.name}"`, graph })
    .returning();
  await touched(row.id);
  return row.id;
}

/** Persist the canvas graph (autosave). Bumps version + updatedAt. */
export async function saveFlowGraph(id: string, graph: FlowGraph): Promise<void> {
  await db
    .update(flows)
    .set({ graph, updatedAt: new Date(), version: dsql`${flows.version} + 1` })
    .where(eq(flows.id, id));
  await touched(id);
}

export async function renameFlow(id: string, name: string): Promise<void> {
  await db
    .update(flows)
    .set({ name: name.trim() || "Untitled flow", updatedAt: new Date() })
    .where(eq(flows.id, id));
  await touched(id);
}

export async function deleteFlow(id: string): Promise<void> {
  // flow_node_runs FK-less; clean children first so the library count is honest.
  const runs = await db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.flowId, id));
  for (const r of runs) {
    await sql`delete from flow_node_runs where flow_run_id = ${r.id}`;
  }
  await db.delete(flowRuns).where(eq(flowRuns.flowId, id));
  await db.delete(flows).where(eq(flows.id, id));
  await touched(id);
}

/** Kick a run off in the worker (LISTEN "flow_run"); returns immediately. */
export async function runFlowNow(id: string): Promise<void> {
  await sql.notify("flow_run", id);
  revalidatePath(`/m/studio/${id}`);
}

/** Set how a flow fires. A schedule cron is validated before it's stored, so a
 *  bad pattern never reaches the worker. NOTIFYs the worker to (re)sync crons. */
export async function setFlowTrigger(id: string, trigger: FlowTrigger): Promise<void> {
  if (trigger.kind === "schedule") {
    if (!trigger.cron?.trim()) throw new Error("a schedule needs a cron pattern");
    try {
      new Cron(trigger.cron).stop();
    } catch {
      throw new Error(`invalid cron pattern: "${trigger.cron}"`);
    }
  }
  if (trigger.kind === "event") {
    // A LISTEN channel name — same charset Postgres identifiers allow.
    if (!/^[a-z_][a-z0-9_]*$/i.test(trigger.channel ?? "")) {
      throw new Error(`invalid event channel: "${trigger.channel}"`);
    }
  }
  await db.update(flows).set({ trigger, updatedAt: new Date() }).where(eq(flows.id, id));
  await touched(id);
}

/** Arm/disarm a flow. Only enabled + schedule-triggered flows get a worker cron. */
export async function setFlowEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(flows).set({ enabled, updatedAt: new Date() }).where(eq(flows.id, id));
  await touched(id);
}

/** Load one past run's trace for the canvas run-picker. */
export async function loadRunView(runId: string): Promise<RunView | null> {
  return runView(runId);
}

export interface NodeTranscriptEvent {
  type: string;
  text?: string;
  name?: string;
  result?: unknown;
  message?: string;
}
export interface NodeTranscript {
  status: string;
  result: string | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  events: NodeTranscriptEvent[];
}

/** Drill into an agent node's run: the full transcript (tools it called, what
 *  they returned, its reasoning) — so the Studio shows what the agent DID. */
export async function loadNodeTranscript(agentRunId: string): Promise<NodeTranscript | null> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
  if (!run) return null;
  return {
    status: run.status,
    result: run.result ?? null,
    error: run.error ?? null,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    events: ((run.transcript ?? []) as NodeTranscriptEvent[]).filter(
      (e) => e && ["tool_call", "tool_result", "text", "error"].includes(e.type),
    ),
  };
}

/** Create a bare agent inline from the Studio, so a flow can wire a fresh agent
 *  without leaving the canvas. Returns the option to select immediately. */
export async function quickCreateAgent(name: string): Promise<AgentOption> {
  const row = await createAgent({
    name: name.trim() || "New agent",
    prompt:
      "You are a flow step. Do your task on the input you're given, then write a concise result. Configure your tools and prompt in the Agents page.",
    tools: [],
  });
  return { id: row.id, name: row.name, tools: row.tools ?? [], provider: row.provider ?? null, model: row.model ?? null };
}

/** Approve or reject a paused human node, then NOTIFY the worker to resume the
 *  run from where it paused. No-op if the node isn't actually waiting. */
export async function decideFlowStep(
  flowId: string,
  flowRunId: string,
  nodeId: string,
  approved: boolean,
): Promise<void> {
  const [nr] = await db
    .select()
    .from(flowNodeRuns)
    .where(and(eq(flowNodeRuns.flowRunId, flowRunId), eq(flowNodeRuns.nodeId, nodeId)));
  if (!nr || nr.status !== "paused") return;
  const sig = (nr.signal as Record<string, unknown> | null) ?? {};
  await db
    .update(flowNodeRuns)
    .set({ signal: { ...sig, decision: approved ? "approved" : "rejected" } })
    .where(eq(flowNodeRuns.id, nr.id));
  await sql.notify("flow_resume", flowRunId);
  revalidatePath(`/m/studio/${flowId}`);
}
