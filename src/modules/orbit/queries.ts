import { sql as dsql } from "drizzle-orm";
import { UMAP } from "umap-js";
import { db } from "@/core/db/client";

/** One node in the orbital graph — a row from the unified search_index. */
export interface OrbitNode {
  id: string;
  kind: string;
  title: string;
  href: string | null;
  /** Coarse cluster (area/project ref) if the item carries one. */
  group: string | null;
  /** Semantic-map position: a 3D UMAP projection of the item's embedding, so
   *  nearness here means "about the same thing". Null if the projection failed. */
  mx: number | null;
  my: number | null;
  mz: number | null;
}

/** A semantic edge — two items whose embeddings are close. */
export interface OrbitLink {
  source: string;
  target: string;
  dist: number;
}

export interface OrbitGraph {
  nodes: OrbitNode[];
  links: OrbitLink[];
  total: number;
}

// The whole corpus at once is unreadable and heavy, so cap to the most
// recently-touched slice; edges are each node's nearest neighbours under the
// app's "genuinely related" cosine-distance gate.
const NODE_LIMIT = 800;
const NEIGHBORS = 6;
const MAX_DIST = 0.5;
const MAP_SCALE = 180; // half-extent of the semantic map, in scene units

// The UMAP projection is the expensive part (~seconds), and the node set is
// stable between loads, so memoise it by the picked-id fingerprint.
let projCache: { key: string; coords: Map<string, [number, number, number]> } | null =
  null;

function parseVec(s: unknown): number[] {
  if (Array.isArray(s)) return s as number[];
  try {
    return JSON.parse(String(s));
  } catch {
    return [];
  }
}

/** Project the embeddings to 3D (UMAP) and normalise each axis to the scene box. */
function project(
  ids: string[],
  vectors: number[][],
): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  if (ids.length < 4) {
    ids.forEach((id) => out.set(id, [0, 0, 0]));
    return out;
  }
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: Math.min(15, ids.length - 1),
    minDist: 0.1,
    spread: 1.2,
    nEpochs: 300,
  });
  const coords = umap.fit(vectors);
  // per-axis min/max → [-MAP_SCALE, MAP_SCALE]
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of coords)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], c[a]);
      hi[a] = Math.max(hi[a], c[a]);
    }
  const norm = (v: number, a: number) => {
    const span = hi[a] - lo[a] || 1;
    return ((v - lo[a]) / span) * 2 * MAP_SCALE - MAP_SCALE;
  };
  ids.forEach((id, i) => {
    const c = coords[i];
    out.set(id, [norm(c[0], 0), norm(c[1], 1), norm(c[2], 2)]);
  });
  return out;
}

/**
 * Build the interconnected graph over everything apOS has embedded — knowledge,
 * the Obsidian vault, notes, tasks, mail, events, people, projects, memory … —
 * from the single `search_index` vector space. Nodes carry both a force-graph
 * identity and a semantic-map position; links are the k-NN between them.
 */
export async function orbitGraph(): Promise<OrbitGraph> {
  const totalRow = await db.execute<{ n: number }>(
    dsql`select count(*)::int as n from search_index where embedding is not null`,
  );
  const total = Number([...totalRow][0]?.n ?? 0);

  const nodeRows = await db.execute<{
    id: string;
    kind: string;
    title: string;
    href: string | null;
    area_ref: string | null;
    project_refs: unknown;
    embedding: unknown;
  }>(dsql`
    select id::text as id, kind,
           coalesce(nullif(title, ''), '(untitled)') as title,
           href, area_ref, project_refs, embedding::text as embedding
      from search_index
     where embedding is not null
     order by updated_at desc
     limit ${NODE_LIMIT}
  `);
  const rows = [...nodeRows];

  // Semantic projection (cached by the picked-id fingerprint).
  const ids = rows.map((r) => r.id);
  const key = `${ids.length}:${ids[0] ?? ""}:${ids[ids.length - 1] ?? ""}`;
  let coords = projCache?.key === key ? projCache.coords : null;
  if (!coords) {
    try {
      coords = project(
        ids,
        rows.map((r) => parseVec(r.embedding)),
      );
      projCache = { key, coords };
    } catch {
      coords = new Map();
    }
  }

  const nodes: OrbitNode[] = rows.map((r) => {
    const refs = Array.isArray(r.project_refs) ? (r.project_refs as string[]) : [];
    const p = coords!.get(r.id) ?? null;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title.slice(0, 120),
      href: r.href,
      group: r.area_ref ?? refs[0] ?? null,
      mx: p ? p[0] : null,
      my: p ? p[1] : null,
      mz: p ? p[2] : null,
    };
  });

  const linkRows = await db.execute<{
    source: string;
    target: string;
    dist: number;
  }>(dsql`
    with picked as (
      select id, embedding from search_index
       where embedding is not null
       order by updated_at desc
       limit ${NODE_LIMIT}
    )
    select least(a.id::text, b.id::text) as source,
           greatest(a.id::text, b.id::text) as target,
           min(a.embedding <=> b.embedding)::float8 as dist
      from picked a
      cross join lateral (
        select n.id, n.embedding
          from picked n
         where n.id <> a.id
         order by a.embedding <=> n.embedding
         limit ${NEIGHBORS}
      ) b
     where (a.embedding <=> b.embedding) < ${MAX_DIST}
     group by 1, 2
  `);

  const links: OrbitLink[] = [...linkRows].map((r) => ({
    source: r.source,
    target: r.target,
    dist: Number(r.dist),
  }));

  return { nodes, links, total };
}
