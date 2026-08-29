import type { FlowEdge, FlowNode } from "@/modules/flows/schema";

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
