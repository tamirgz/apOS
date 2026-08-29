import {
  FLOW_NODE_KINDS,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowNodeKind,
} from "@/modules/flows/schema";

const KINDS = new Set<string>(FLOW_NODE_KINDS);

/**
 * Validate + sanitize an untrusted graph (from an imported JSON file): keep only
 * well-formed nodes of a known kind and edges between existing nodes. Returns
 * null if there's nothing usable.
 */
export function sanitizeFlowGraph(raw: unknown): FlowGraph | null {
  const g = raw as { nodes?: unknown; edges?: unknown } | null;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  const nodes: FlowNode[] = [];
  for (const n of g.nodes as Record<string, unknown>[]) {
    if (!n || typeof n.id !== "string" || typeof n.kind !== "string" || !KINDS.has(n.kind)) continue;
    nodes.push({
      id: n.id,
      kind: n.kind as FlowNodeKind,
      name: typeof n.name === "string" ? n.name : undefined,
      x: typeof n.x === "number" ? n.x : 0,
      y: typeof n.y === "number" ? n.y : 0,
      config: n.config && typeof n.config === "object" ? (n.config as Record<string, unknown>) : {},
    });
  }
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges: FlowEdge[] = [];
  for (const e of g.edges as Record<string, unknown>[]) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    edges.push({
      id: typeof e.id === "string" ? e.id : undefined,
      from: e.from,
      to: e.to,
      fromPort: typeof e.fromPort === "string" ? e.fromPort : undefined,
    });
  }
  return { nodes, edges };
}

/**
 * Does the graph contain a directed cycle? The engine's dataflow scheduler
 * never converges on a cycle (it throws "did not converge"), so the editor
 * warns and blocks Run before that runtime failure. Classic white/grey/black DFS.
 */
export function hasCycle(nodes: FlowNode[], edges: FlowEdge[]): boolean {
  const out = new Map<string, string[]>();
  for (const n of nodes) out.set(n.id, []);
  for (const e of edges) {
    if (out.has(e.from) && out.has(e.to)) out.get(e.from)!.push(e.to);
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 in-stack, 2 done
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true; // back-edge → cycle
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (visit(to)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) {
    if (state.get(n.id) !== 2 && visit(n.id)) return true;
  }
  return false;
}
