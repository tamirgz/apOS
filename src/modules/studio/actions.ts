"use server";

import { Cron } from "croner";
import { eq, sql as dsql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { agents } from "@/core/db/schema/agents";
import {
  flowRuns,
  flows,
  type FlowGraph,
  type FlowTrigger,
} from "@/modules/flows/schema";
import { runView, type RunView } from "./queries";

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
