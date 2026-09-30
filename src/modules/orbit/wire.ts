import type { OrbitGraph, OrbitNode, OrbitRegion } from "./queries";

/**
 * The graph as it crosses to the browser. ~3k nodes and ~20k edges as JSON
 * objects came to 2.6 MB — mostly edges repeating two 36-char ids each — and
 * the page couldn't show until all of it had streamed and parsed. Tuples with
 * edges as node indices and rounded coordinates carry the same graph in a
 * fraction of that; `unpackOrbit` rebuilds the objects on the client.
 */
export interface OrbitWire {
  /** [id, kind, title, href, group, mx, my, cluster] */
  nodes: [string, string, string, string | null, string | null, number | null, number | null, number | null][];
  /** [source index, target index, distance ×1000] */
  links: [number, number, number][];
  regions: OrbitRegion[];
  total: number;
  atlasBuiltAt: string | null;
}

const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

export function packOrbit(g: OrbitGraph): OrbitWire {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  return {
    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.href, n.group, round1(n.mx), round1(n.my), n.cluster]),
    links: g.links.flatMap((l) => {
      const a = index.get(l.source);
      const b = index.get(l.target);
      return a == null || b == null ? [] : [[a, b, Math.round(l.dist * 1000)] as [number, number, number]];
    }),
    regions: g.regions,
    total: g.total,
    atlasBuiltAt: g.atlasBuiltAt,
  };
}

export function unpackOrbit(w: OrbitWire): OrbitGraph {
  const nodes: OrbitNode[] = w.nodes.map(([id, kind, title, href, group, mx, my, cluster]) => ({
    id,
    kind,
    title,
    href,
    group,
    mx,
    my,
    mz: mx == null ? null : 0,
    cluster,
  }));
  return {
    nodes,
    links: w.links.map(([a, b, d]) => ({ source: nodes[a].id, target: nodes[b].id, dist: d / 1000 })),
    regions: w.regions,
    total: w.total,
    atlasBuiltAt: w.atlasBuiltAt,
  };
}
