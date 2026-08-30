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
import { isUniqueViolation } from "@/core/db/errors";
import { agentRuns } from "@/core/db/schema/agents";
import { executeRun } from "@/worker/executor";
import {
  flowNodeRuns,
  flowRuns,
  flows,
  type FlowGraph,
  type FlowNode,
  type FlowNodeRun,
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
  // Event-triggered fires seed the graph's entry node(s) with what fired them
  // (e.g. "telegram_new_post: <post id>"), so the first agent can look it up.
  seed: FlowPayload | null = null,
): Promise<string | null> {
  const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
  if (!flow) return null;
  const [run] = await db
    .insert(flowRuns)
    .values({ flowId, trigger, status: "running", startedAt: new Date() })
    .returning();
  log(`▶ "${flow.name}" run ${run.id}`);
  bump(run.id);
  await settleGraph(flow.name, run.id, () => executeGraph(flow.graph, run.id, 0, seed));
  return run.id;
}

/** Resume a paused run — replay executeGraph, reusing every node that already
 *  ran (memoized by nodeId), so the human gate continues and nothing re-executes. */
export async function resumeFlow(flowRunId: string): Promise<void> {
  const [run] = await db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId));
  if (!run || run.status !== "paused") return;
  const [flow] = await db.select().from(flows).where(eq(flows.id, run.flowId));
  if (!flow) return;
  const priors = await db
    .select()
    .from(flowNodeRuns)
    .where(eq(flowNodeRuns.flowRunId, flowRunId));
  const memo = new Map<string, FlowNodeRun>();
  for (const r of priors) {
    // Prefer a terminal state over a stale "running"/"pending" duplicate.
    const cur = memo.get(r.nodeId);
    if (!cur || cur.status === "running" || cur.status === "pending") memo.set(r.nodeId, r);
  }
  await db.update(flowRuns).set({ status: "running" }).where(eq(flowRuns.id, flowRunId));
  bump(flowRunId);
  log(`▶ resuming "${flow.name}" run ${flowRunId}`);
  await settleGraph(flow.name, flowRunId, () =>
    executeGraph(flow.graph, flowRunId, 0, null, memo),
  );
}

/** Shared terminal handling: run/resume a graph, then set the run
 *  succeeded / paused / failed. */
async function settleGraph(
  flowName: string,
  flowRunId: string,
  run: () => Promise<GraphResult>,
): Promise<void> {
  try {
    const res = await run();
    if (res.paused) {
      log(`⏸ "${flowName}" run ${flowRunId} paused (awaiting a human decision)`);
    } else {
      await db
        .update(flowRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(flowRuns.id, flowRunId));
      log(`✔ "${flowName}" run ${flowRunId} succeeded`);
    }
  } catch (e) {
    await db
      .update(flowRuns)
      .set({ status: "failed", error: String(e).slice(0, 500), finishedAt: new Date() })
      .where(eq(flowRuns.id, flowRunId));
    log(`✘ "${flowName}" run ${flowRunId} failed: ${e}`);
    try {
      const { reportJobOutcome } = await import("@/core/alerts");
      await reportJobOutcome(`flow:${flowName}`, false, e);
    } catch {
      /* best-effort */
    }
  }
  bump(flowRunId);
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
interface GraphResult {
  /** A human node is waiting on a decision — the run is suspended, not done. */
  paused: boolean;
  /** Combined terminal-node output (for a sub-flow's caller). */
  output: FlowPayload | null;
}

async function executeGraph(
  graph: FlowGraph,
  flowRunId: string,
  depth = 0,
  seed: FlowPayload | null = null,
  memo: Map<string, FlowNodeRun> = new Map(),
): Promise<GraphResult> {
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

  const inputOf = (n: FlowNode): FlowPayload | null => {
    const inbound = inE.get(n.id)!;
    if (inbound.length === 0 && seed) return seed;
    return combine(
      inbound
        .filter((e) => est.get(e.i)!.status === "delivered")
        .map((e) => est.get(e.i)!.payload ?? null),
    );
  };
  const deliver = (n: FlowNode, output: FlowPayload | null, ports: string[] | null) => {
    for (const oe of outE.get(n.id)!) {
      const take =
        ports === null ||
        ports.includes(oe.fromPort ?? "") ||
        ports.includes(String(portIndex(n, oe.fromPort)));
      est.set(oe.i, take ? { status: "delivered", payload: output } : { status: "skipped" });
    }
  };
  const skipEdges = (n: FlowNode) => {
    for (const oe of outE.get(n.id)!) est.set(oe.i, { status: "skipped" });
  };

  let guard = 0;
  let paused = false;
  for (;;) {
    if (++guard > nodes.length * 4 + 20) throw new Error("flow did not converge (cycle?)");
    const batch = nodes.filter((n) => nstate.get(n.id) === "pending" && ready(n));
    if (!batch.length) break;

    // Pass A — reuse memoized runs (resume) and resolve human gates. A human
    // node with no decision suspends the WHOLE run before any fresh node starts,
    // so a resume never re-executes an agent that already ran.
    const fresh: FlowNode[] = [];
    for (const n of batch) {
      const prior = memo.get(n.id);
      if (prior && prior.status === "succeeded") {
        const out = (prior.output as FlowPayload | null) ?? null;
        nstate.set(n.id, "done");
        nodeOutputs.set(n.id, out);
        deliver(n, out, memoPorts(n, prior));
        continue;
      }
      if (prior && prior.status === "skipped") {
        nstate.set(n.id, "skipped");
        skipEdges(n);
        continue;
      }
      if (allSkipped(n)) {
        nstate.set(n.id, "skipped");
        await recordSkip(n, flowRunId);
        skipEdges(n);
        continue;
      }
      if (n.kind === "human") {
        const decided = await settleHuman(n, inputOf(n), flowRunId, prior ?? null);
        if (!decided) {
          paused = true;
          break;
        }
        nstate.set(n.id, "done");
        nodeOutputs.set(n.id, decided.output);
        deliver(n, decided.output, decided.approved ? null : []);
        continue;
      }
      fresh.push(n);
    }
    if (paused) break;

    // Pass B — run the remaining fresh nodes concurrently.
    await Promise.all(
      fresh.map(async (n) => {
        const { output, ports } = await runNode(n, inputOf(n), flowRunId, depth);
        nstate.set(n.id, "done");
        nodeOutputs.set(n.id, output);
        deliver(n, output, ports);
      }),
    );
  }

  if (paused) return { paused: true, output: null };
  // The sub-flow's result = the combined output of its terminal (leaf) nodes.
  const terminals = nodes.filter(
    (n) => outE.get(n.id)!.length === 0 && nstate.get(n.id) === "done",
  );
  return { paused: false, output: combine(terminals.map((n) => nodeOutputs.get(n.id) ?? null)) };
}

/** Reconstruct a memoized node's output ports on resume (branch/filter routed
 *  by their stored signal; everything else delivers on all ports). */
function memoPorts(node: FlowNode, run: FlowNodeRun): string[] | null {
  const sig = run.signal as Record<string, unknown> | null;
  if (node.kind === "branch") {
    const chose = sig?.chose;
    return chose == null ? null : [String(chose), String(portIndex(node, String(chose)))];
  }
  if (node.kind === "filter") return sig?.pass === false ? [] : null;
  if (node.kind === "human") return sig?.decision === "rejected" ? [] : null;
  return null;
}

/** Resolve a human gate. Returns { approved, output } once decided, else null
 *  (records a paused node-run + pauses the run, awaiting Approve/Reject). */
async function settleHuman(
  node: FlowNode,
  input: FlowPayload | null,
  flowRunId: string,
  prior: FlowNodeRun | null,
): Promise<{ approved: boolean; output: FlowPayload } | null> {
  const sig = (prior?.signal as Record<string, unknown> | null) ?? null;
  const decision = sig?.decision as string | undefined;
  if (decision === "approved" || decision === "rejected") {
    const approved = decision === "approved";
    const output: FlowPayload = {
      ...(input ?? {}),
      signal: { ...(input?.signal ?? {}), approved },
      from: node.name ?? "human",
    };
    if (prior) {
      await db
        .update(flowNodeRuns)
        .set({ status: "succeeded", output, finishedAt: new Date() })
        .where(eq(flowNodeRuns.id, prior.id));
    }
    bump(flowRunId);
    return { approved, output };
  }
  // No decision yet → park. Record the paused node-run once, alert the user.
  if (!prior) {
    const prompt = String(node.config?.prompt ?? node.config?.question ?? "Approve to continue.");
    await db.insert(flowNodeRuns).values({
      flowRunId,
      nodeId: node.id,
      kind: "human",
      status: "paused",
      input: input ?? null,
      signal: { prompt, awaiting: true },
      startedAt: new Date(),
    });
    try {
      const { notify } = await import("@/core/notify");
      await notify({
        title: `Flow waiting: ${node.name ?? "review"}`,
        body: prompt,
        source: "flow",
        level: "info",
      });
    } catch {
      /* best-effort */
    }
  }
  await db.update(flowRuns).set({ status: "paused" }).where(eq(flowRuns.id, flowRunId));
  bump(flowRunId);
  return null;
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
    } else if (node.kind === "source") {
      output = await runSourceNode(node);
    } else if (node.kind === "tool") {
      output = await runToolNode(node, input);
    } else if (node.kind === "output") {
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
      await db
        .update(flowNodeRuns)
        .set({ signal: { pass } }) // persisted so a resume reconstructs the route
        .where(eq(flowNodeRuns.id, nr.id));
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
    throw new Error("agent node has no agentId (pick an agent in the inspector)");
  // The partial unique index allows ONE live run per agent — an agent that is
  // also on a cron (or in a concurrently-running flow) makes this insert
  // conflict. Instead of failing the whole flow, wait for the live run to
  // clear (bounded), then claim the slot.
  const AGENT_BUSY_WAIT_MS = 3 * 60 * 1000;
  const started = Date.now();
  let ar: typeof agentRuns.$inferSelect | undefined;
  for (;;) {
    try {
      [ar] = await db
        .insert(agentRuns)
        .values({ agentId, trigger: "flow", status: "queued", flowNodeRunId: nodeRunId })
        .returning();
      break;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (Date.now() - started > AGENT_BUSY_WAIT_MS)
        throw new Error(
          `agent "${node.name ?? agentId}" already has a live run (cron overlap?) and it didn't finish within ${AGENT_BUSY_WAIT_MS / 60000} min`,
        );
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  await db.update(flowNodeRuns).set({ agentRunId: ar.id }).where(eq(flowNodeRuns.id, nodeRunId));
  // Per-node model override: this flow can run the agent on a different model
  // than the agent's own default (Flow A → big model, Flow B → fast local).
  const provider = (node.config?.provider as string | undefined) || null;
  const model = (node.config?.model as string | undefined) || null;
  await executeRun(ar.id, provider || model ? { provider: provider as never, model } : undefined);
  const [finished] = await db.select().from(agentRuns).where(eq(agentRuns.id, ar.id));
  if (!finished)
    throw new Error(`agent "${node.name ?? agentId}" run ${ar.id} vanished mid-flow`);
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
    const res = await executeGraph(flow.graph, run.id, depth, input);
    if (res.paused) throw new Error("a human step can't run inside a sub-flow");
    await db
      .update(flowRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(flowRuns.id, run.id));
    bump(run.id);
    return res.output;
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

/**
 * Source node — inject a concrete data source as the flow's seed, so you CONTROL
 * what a step sees instead of relying on an agent's own tools. No upstream input.
 *   • text      → a literal string (a fixed brief / instruction)
 *   • search    → semantic search over the whole corpus (query, limit)
 *   • knowledge → search scoped to notes / knowledge / vault (query)
 *   • projects  → your active projects with health + next action
 *   • people    → people with their open follow-ups
 */
async function runSourceNode(node: FlowNode): Promise<FlowPayload> {
  const type = String(node.config?.sourceType ?? "text");

  if (type === "search" || type === "knowledge") {
    const query = String(node.config?.query ?? "").trim();
    if (!query) throw new Error(`${type} source has no query`);
    const limit = Math.min(Math.max(1, Number(node.config?.limit ?? 8)), 25);
    const { searchEverything } = await import("@/core/embeddings");
    let hits = await searchEverything(query, limit * (type === "knowledge" ? 2 : 1));
    if (type === "knowledge") {
      hits = hits.filter((h) => ["knowledge", "note", "vault"].includes(h.kind)).slice(0, limit);
    }
    const report =
      hits
        .map((h, i) => `${i + 1}. [${h.kind}] ${h.title}${h.snippet ? ` — ${h.snippet}` : ""}`)
        .join("\n") || "(no results)";
    return {
      report,
      signal: { count: hits.length, query, items: hits.map((h) => ({ title: h.title, kind: h.kind, href: h.href })) },
      from: node.name ?? type,
    };
  }

  if (type === "projects") {
    const { getProjectCockpit } = await import("@/modules/projects/queries");
    const all = await getProjectCockpit(db);
    const active = all.filter((p) => p.status === "active");
    const report =
      active
        .map(
          (p) =>
            `- ${p.name} — ${p.resolvedHealth.health}${p.nextAction ? ` · next: ${p.nextAction}` : ""}`,
        )
        .join("\n") || "(no active projects)";
    return {
      report,
      signal: {
        count: active.length,
        projects: active.map((p) => ({ name: p.name, health: p.resolvedHealth.health })),
      },
      from: node.name ?? "projects",
    };
  }

  if (type === "people") {
    const { listPeople } = await import("@/modules/people/queries");
    const people = (await listPeople(db)).filter((p) => p.name?.trim());
    const report =
      people
        .map(
          (p) =>
            `- ${p.name}${p.openFollowups ? ` · ${p.openFollowups} open follow-up${p.openFollowups > 1 ? "s" : ""}` : ""}`,
        )
        .join("\n") || "(no people)";
    return {
      report,
      signal: { count: people.length },
      from: node.name ?? "people",
    };
  }

  // literal text seed
  const text = String(node.config?.text ?? "");
  return { report: text, signal: { text }, from: node.name ?? "source" };
}

/**
 * Tool node — run ONE registered tool directly, no agent. Args come from the
 * node's `args` JSON (with {{report}} / {{signal.x}} interpolation from the
 * upstream payload). The tool's result flows downstream as report + signal.
 */
async function runToolNode(node: FlowNode, input: FlowPayload | null): Promise<FlowPayload> {
  const toolName = String(node.config?.tool ?? "").trim();
  if (!toolName) throw new Error("tool node has no tool selected");
  const { getToolsByNames } = await import("@/core/ai/tool-registry");
  const [def] = getToolsByNames([toolName]);
  if (!def) throw new Error(`unknown tool "${toolName}"`);
  // Interpolate {{report}} and {{signal.key}} from the upstream payload into the
  // args template, then validate against the tool's own schema.
  const raw = String(node.config?.args ?? "{}");
  const signal = (input?.signal as Record<string, unknown>) ?? {};
  const filled = raw
    .replace(/\{\{\s*report\s*\}\}/g, () => JSON.stringify(input?.report ?? "").slice(1, -1))
    .replace(/\{\{\s*signal\.([\w]+)\s*\}\}/g, (_m, k) =>
      JSON.stringify(signal[k] ?? "").replace(/^"|"$/g, ""),
    );
  let args: unknown;
  try {
    args = def.input.parse(JSON.parse(filled || "{}"));
  } catch (e) {
    throw new Error(`tool "${toolName}" args invalid: ${String(e).slice(0, 160)}`);
  }
  const result = await def.execute(args, { db } as never);
  return {
    // A readable rendering for delivery / an agent's eyes; the FULL structured
    // result stays on `signal` for a downstream branch/tool to compute on.
    report: renderToolResult(result),
    signal: (result && typeof result === "object" ? (result as Record<string, unknown>) : { result }),
    from: node.name ?? toolName,
  };
}

/** Human-readable rendering of a tool's result — a compact list/summary, not a
 *  raw JSON wall (which reads terribly when a tool node feeds a Slack/notify). */
function renderToolResult(result: unknown): string {
  if (result == null) return "(no result)";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const line = (o: unknown): string => {
    if (o == null) return "·";
    if (typeof o !== "object") return String(o);
    const r = o as Record<string, unknown>;
    const label = r.name ?? r.title ?? r.label ?? r.summary ?? r.id;
    if (label != null) return String(label);
    // a small scalar object → "k: v" pairs; else compact JSON
    const scalars = Object.entries(r).filter(([, v]) => v == null || typeof v !== "object");
    if (scalars.length && scalars.length <= 6) {
      return scalars.map(([k, v]) => `${k}: ${v ?? "—"}`).join(", ");
    }
    return JSON.stringify(r);
  };
  if (Array.isArray(result)) {
    if (result.length === 0) return "(no items)";
    const shown = result.slice(0, 20).map((x) => `• ${line(x)}`);
    const more = result.length > 20 ? `\n…and ${result.length - 20} more` : "";
    return `${result.length} item${result.length > 1 ? "s" : ""}:\n${shown.join("\n")}${more}`;
  }
  return line(result);
}

/** Terminal delivery — write the upstream result to a surface. */
async function runOutputNode(
  node: FlowNode,
  input: FlowPayload | null,
): Promise<FlowPayload | null> {
  const tool = (node.config?.tool as string) || "notify";
  const report =
    input?.report ?? (typeof input === "string" ? input : JSON.stringify(input ?? {}));
  const title = node.name || "Flow result";
  const body = String(report).slice(0, 1500);
  if (tool === "notify") {
    const { notify } = await import("@/core/notify");
    await notify({ title, body, source: "flow", level: "info" });
  } else if (tool === "card") {
    // Raise a "Needs you" attention card with the flow's result.
    const { insertAttentionItem } = await import("@/modules/today/core");
    await insertAttentionItem({ type: "notify", title, body, source: "flow", urgency: 20 });
  } else if (tool === "slack") {
    // Deliver through the notification pipeline, which the worker mirrors to
    // Slack when a webhook is configured (no-op otherwise).
    const { notify } = await import("@/core/notify");
    await notify({ title, body, source: "flow", level: "info" });
  } else if (tool === "cockpit") {
    // Cockpit brief — post to the dashboard's bell feed tagged as a brief, so
    // it surfaces alongside the day's cockpit rather than as a to-do.
    const { notify } = await import("@/core/notify");
    await notify({ title: `Brief · ${title}`, body, source: "cockpit", level: "info" });
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
