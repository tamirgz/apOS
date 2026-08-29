/**
 * The Flow Engine — a graph interpreter that ORCHESTRATES existing primitives.
 * It walks a flow's graph, runs each node, and passes one node's output into the
 * next along its wires. Agent nodes run as REAL agent_runs (reusing the executor
 * unchanged), so their tools, routing, memory and self-learning all apply; the
 * flow just decides who runs, in what order, on whose result.
 *
 * Phase 2 — a dataflow scheduler with PORTS and SKIP propagation:
 *   • branch  → evaluates a condition and delivers on ONE output port; the other
 *               ports (and everything downstream of them) are skipped.
 *   • fan-out → delivers on all ports; downstream branches run in PARALLEL.
 *   • merge   → a join: runs once its inbound edges resolve, combining them.
 *   • filter  → passes (all ports) or drops (skips downstream) on a condition.
 * Condition = a structured expression over the upstream signal, else a free
 * local-model yes/no judge. Human / loop / sub-routine land in Phase 4.
 */
import { eq } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
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

/** Nudge the Studio canvas (SSE "flow_runs") that this run's state changed. */
const bump = (flowRunId: string) => {
  void sql.notify("flow_runs", flowRunId).catch(() => {});
};

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
  bump(run.id);
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
    try {
      const { reportJobOutcome } = await import("@/core/alerts");
      await reportJobOutcome(`flow:${flow.name}`, false, e);
    } catch {
      /* best-effort */
    }
  }
  bump(run.id);
  return run.id;
}

type EdgeS = { status: "pending" | "delivered" | "skipped"; payload?: FlowPayload | null };

/** How deep sub-flows may nest before we call it a runaway recursion. */
const MAX_DEPTH = 6;

/**
 * Dataflow scheduler. An edge resolves to delivered|skipped; a node is ready
 * once every inbound edge is resolved. If ALL its inbound are skipped the node
 * is skipped and the skip cascades; otherwise it runs on its delivered inputs
 * and emits on the ports its kind selects. Ready nodes run concurrently.
 *
 * `seed` is delivered to the root (input-less) nodes — how a sub-flow receives
 * its caller's payload. Returns the combined output of the terminal (no-outgoing)
 * nodes, so a sub-routine/loop can read a sub-flow's result.
 */
async function executeGraph(
  graph: FlowGraph,
  flowRunId: string,
  depth = 0,
  seed: FlowPayload | null = null,
): Promise<FlowPayload | null> {
  const { nodes } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const E = graph.edges
    .map((e, i) => ({ ...e, i }))
    .filter((e) => byId.has(e.from) && byId.has(e.to));
  const inE = new Map<string, typeof E>();
  const outE = new Map<string, typeof E>();
  for (const n of nodes) {
    inE.set(n.id, []);
    outE.set(n.id, []);
  }
  for (const e of E) {
    inE.get(e.to)!.push(e);
    outE.get(e.from)!.push(e);
  }
  const est = new Map<number, EdgeS>(E.map((e) => [e.i, { status: "pending" }]));
  const nstate = new Map<string, "pending" | "done" | "skipped">(
    nodes.map((n) => [n.id, "pending"]),
  );
  const nodeOutputs = new Map<string, FlowPayload | null>();
  const resolved = (e: (typeof E)[number]) => est.get(e.i)!.status !== "pending";
  const ready = (n: FlowNode) => inE.get(n.id)!.every(resolved);
  const allSkipped = (n: FlowNode) => {
    const ins = inE.get(n.id)!;
    return ins.length > 0 && ins.every((e) => est.get(e.i)!.status === "skipped");
  };

  let guard = 0;
  for (;;) {
    if (++guard > nodes.length * 4 + 20) throw new Error("flow did not converge (cycle?)");
    const batch = nodes.filter((n) => nstate.get(n.id) === "pending" && ready(n));
    if (!batch.length) break;
    await Promise.all(
      batch.map(async (n) => {
        if (allSkipped(n)) {
          nstate.set(n.id, "skipped");
          await recordSkip(n, flowRunId);
          for (const oe of outE.get(n.id)!) est.set(oe.i, { status: "skipped" });
          return;
        }
        const inbound = inE.get(n.id)!;
        const inputs = inbound
          .filter((e) => est.get(e.i)!.status === "delivered")
          .map((e) => est.get(e.i)!.payload ?? null);
        // Root (input-less) nodes receive the caller's seed, if any.
        const input = inbound.length === 0 && seed ? seed : combine(inputs);
        const { output, ports } = await runNode(n, input, flowRunId, depth);
        nstate.set(n.id, "done");
        nodeOutputs.set(n.id, output);
        for (const oe of outE.get(n.id)!) {
          const take =
            ports === null ||
            ports.includes(oe.fromPort ?? "") ||
            ports.includes(String(portIndex(n, oe.fromPort)));
          est.set(oe.i, take ? { status: "delivered", payload: output } : { status: "skipped" });
        }
      }),
    );
  }

  // The sub-flow's result = the combined output of its terminal (leaf) nodes.
  const terminals = nodes.filter(
    (n) => outE.get(n.id)!.length === 0 && nstate.get(n.id) === "done",
  );
  return combine(terminals.map((n) => nodeOutputs.get(n.id) ?? null));
}

/** Merge several inbound payloads into one (report concatenated, signals merged). */
function combine(payloads: (FlowPayload | null)[]): FlowPayload | null {
  const ps = payloads.filter(Boolean) as FlowPayload[];
  if (ps.length === 0) return null;
  if (ps.length === 1) return ps[0];
  return {
    report: ps.map((p) => p.report).filter(Boolean).join("\n\n— — —\n\n"),
    signal: Object.assign({}, ...ps.map((p) => p.signal ?? {})),
    from: ps.map((p) => p.from).filter(Boolean).join(" + "),
  };
}

const portIndex = (n: FlowNode, port?: string) => {
  const ports = (n.config?.ports as string[] | undefined) ?? [];
  const i = ports.indexOf(port ?? "");
  return i < 0 ? (port ?? "") : i;
};

/** Run one node; returns its output payload and which out-ports to deliver on
 *  (null = all). Persists a flow_node_run for the trace. */
async function runNode(
  node: FlowNode,
  input: FlowPayload | null,
  flowRunId: string,
  depth: number,
): Promise<{ output: FlowPayload | null; ports: string[] | null }> {
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
  bump(flowRunId);
  try {
    let output: FlowPayload | null = input;
    let ports: string[] | null = null;

    if (node.kind === "trigger") {
      // Top-level: no input → just a start marker. Sub-flow: emits the seed
      // its caller (sub-routine/loop) handed in, so the child sees the payload.
      output = input ?? { from: node.name ?? "trigger" };
    } else if (node.kind === "agent") {
      output = await runAgentNode(node, input, nr.id);
    } else if (node.kind === "output" || node.kind === "tool") {
      output = await runOutputNode(node, input);
    } else if (node.kind === "branch") {
      const labels = (node.config?.ports as string[] | undefined) ?? ["true", "false"];
      const cond = String(node.config?.condition ?? node.config?.cond ?? "");
      const truthy = await evalCondition(cond, input);
      const idx = truthy ? 0 : 1;
      ports = [labels[idx], String(idx)];
      output = { ...(input ?? {}), from: node.name ?? "branch" };
      await db
        .update(flowNodeRuns)
        .set({ signal: { chose: labels[idx], truthy } })
        .where(eq(flowNodeRuns.id, nr.id));
    } else if (node.kind === "filter") {
      const cond = String(node.config?.condition ?? node.config?.cond ?? "");
      const pass = await evalCondition(cond, input);
      ports = pass ? null : []; // pass → all ports; drop → none (skip downstream)
      output = input;
    } else if (node.kind === "subroutine") {
      output = await runSubroutineNode(node, input, depth);
    } else if (node.kind === "loop") {
      output = await runLoopNode(node, input, depth, nr.id);
    }
    // fanout / merge → default: pass through on all ports.

    await db
      .update(flowNodeRuns)
      .set({ status: "succeeded", output: output ?? null, finishedAt: new Date() })
      .where(eq(flowNodeRuns.id, nr.id));
    bump(flowRunId);
    return { output, ports };
  } catch (e) {
    await db
      .update(flowNodeRuns)
      .set({ status: "failed", error: String(e).slice(0, 500), finishedAt: new Date() })
      .where(eq(flowNodeRuns.id, nr.id));
    bump(flowRunId);
    throw e;
  }
}

async function recordSkip(node: FlowNode, flowRunId: string): Promise<void> {
  await db.insert(flowNodeRuns).values({
    flowRunId,
    nodeId: node.id,
    kind: node.kind,
    status: "skipped",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  bump(flowRunId);
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

/** Run another flow inline as a child run, seeded with `input`; returns its
 *  terminal output. The depth guard stops runaway sub-flow recursion. */
async function runSubflow(
  flowId: string,
  input: FlowPayload | null,
  depth: number,
): Promise<FlowPayload | null> {
  if (depth > MAX_DEPTH) throw new Error(`sub-flow nesting exceeded ${MAX_DEPTH}`);
  const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
  if (!flow) throw new Error("sub-flow target not found");
  const [run] = await db
    .insert(flowRuns)
    .values({ flowId, trigger: "subroutine", status: "running", startedAt: new Date() })
    .returning();
  bump(run.id);
  try {
    const out = await executeGraph(flow.graph, run.id, depth, input);
    await db
      .update(flowRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(flowRuns.id, run.id));
    bump(run.id);
    return out;
  } catch (e) {
    await db
      .update(flowRuns)
      .set({ status: "failed", error: String(e).slice(0, 500), finishedAt: new Date() })
      .where(eq(flowRuns.id, run.id));
    bump(run.id);
    throw e;
  }
}

/** Sub-routine node — run the referenced flow once on the upstream payload. */
async function runSubroutineNode(
  node: FlowNode,
  input: FlowPayload | null,
  depth: number,
): Promise<FlowPayload | null> {
  const flowId = node.config?.flowId as string | undefined;
  if (!flowId) throw new Error("sub-flow node has no target flow");
  return runSubflow(flowId, input, depth + 1);
}

/** Pull the collection a loop iterates: config.items literal, else the named
 *  key on the upstream signal (default "items"). */
function loopItems(node: FlowNode, input: FlowPayload | null): unknown[] {
  const literal = node.config?.items;
  if (Array.isArray(literal)) return literal;
  const key = (node.config?.itemsKey as string) || "items";
  const v = (input?.signal as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? v : [];
}

/** Loop node — run the referenced sub-flow once per item, bounded. Each iteration
 *  is seeded with { report: <item>, signal: { item, index } }. */
async function runLoopNode(
  node: FlowNode,
  input: FlowPayload | null,
  depth: number,
  nodeRunId: string,
): Promise<FlowPayload | null> {
  const flowId = node.config?.flowId as string | undefined;
  if (!flowId) throw new Error("loop node has no sub-flow to run per item");
  const max = Math.min(Math.max(1, Number(node.config?.maxIterations ?? 10)), 50);
  const items = loopItems(node, input).slice(0, max);
  const results: (FlowPayload | null)[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemInput: FlowPayload = {
      report: typeof item === "string" ? item : JSON.stringify(item),
      signal: { item, index: i },
      from: node.name ?? "loop",
    };
    results.push(await runSubflow(flowId, itemInput, depth + 1));
  }
  await db
    .update(flowNodeRuns)
    .set({ signal: { iterations: results.length, bounded: loopItems(node, input).length > max } })
    .where(eq(flowNodeRuns.id, nodeRunId));
  return {
    report: results.map((r) => r?.report).filter(Boolean).join("\n\n— — —\n\n"),
    signal: { count: results.length, results: results.map((r) => r?.signal ?? null) },
    from: node.name ?? "loop",
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
  return input;
}

// ── Condition evaluation ─────────────────────────────────────────────────────
/** True/false for a branch or filter: a structured expression over the upstream
 *  signal when possible, else a free local-model yes/no judge on the report. */
async function evalCondition(
  cond: string,
  input: FlowPayload | null,
): Promise<boolean> {
  if (!cond.trim()) return true;
  const signal = (input?.signal as Record<string, unknown>) ?? {};
  const structured = tryExpr(cond, signal);
  if (structured !== null) return structured;
  return judge(cond, input?.report ?? "");
}

/** Evaluate `field op value` against the signal object; null if not applicable. */
function tryExpr(cond: string, signal: Record<string, unknown>): boolean | null {
  const m = cond.match(/^\s*([\w.]+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+?)\s*$/i);
  if (!m) return null;
  const [, lhsRaw, op, rhsRaw] = m;
  const field = lhsRaw.includes(".") ? lhsRaw.split(".").pop()! : lhsRaw;
  const val = signal[field];
  if (val === undefined || val === null) return null; // can't judge structurally
  const rhs = rhsRaw.replace(/^["']|["']$/g, "");
  const vn = Number(val);
  const rn = Number(rhs);
  const numeric = Number.isFinite(vn) && Number.isFinite(rn);
  const seq = String(val).trim().toLowerCase() === rhs.trim().toLowerCase();
  switch (op.toLowerCase()) {
    case "==": return seq || (numeric && vn === rn);
    case "!=": return !seq && !(numeric && vn === rn);
    case ">=": return numeric ? vn >= rn : null;
    case "<=": return numeric ? vn <= rn : null;
    case ">": return numeric ? vn > rn : null;
    case "<": return numeric ? vn < rn : null;
    case "contains": return String(val).toLowerCase().includes(rhs.toLowerCase());
    default: return null;
  }
}

/** Free local-model yes/no judge for a natural-language condition. */
async function judge(cond: string, report: string): Promise<boolean> {
  try {
    const { resolveRoute } = await import("@/core/ai/routing");
    const route = await resolveRoute("memory.distill");
    const system =
      "You are a strict yes/no gate. Given a RESULT and a CONDITION, decide if the condition is true of the result. Answer with ONLY 'yes' or 'no'.";
    const user = `CONDITION: ${cond}\n\nRESULT:\n${String(report).slice(0, 2000)}\n\nIs the condition true? Answer yes or no.`;
    let out = "";
    for await (const ev of route.provider.run({
      system,
      messages: [{ role: "user", content: `/no_think\n${user}` }],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
    })) {
      if (ev.type === "done") out = ev.text;
    }
    return /\byes\b/i.test(out.replace(/<think>[\s\S]*?<\/think>/gi, ""));
  } catch {
    return false; // if the judge can't run, don't take the conditional branch
  }
}
