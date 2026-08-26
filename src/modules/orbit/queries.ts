import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";

/** One node in the orbital graph — a row from the unified search_index. */
export interface OrbitNode {
  id: string;
  kind: string;
  title: string;
  href: string | null;
  /** Coarse cluster (area/project ref) if the item carries one — used to group. */
  group: string | null;
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

// The whole corpus in 3D at once is unreadable and heavy, so cap to the most
// recently-touched slice; edges are the k nearest neighbours of each capped
// node under a "genuinely related" cosine-distance gate (mirrors the app's
// existing relations threshold).
const NODE_LIMIT = 800;
const NEIGHBORS = 6;
const MAX_DIST = 0.5;

/**
 * Build the interconnected graph over everything apOS has embedded — knowledge,
 * the Obsidian vault, notes, tasks, mail, events, people, projects, memory … —
 * from the single `search_index` vector space. Nodes are index rows; links are
 * the semantic k-NN between them.
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
  }>(dsql`
    select id::text as id, kind,
           coalesce(nullif(title, ''), '(untitled)') as title,
           href, area_ref, project_refs
      from search_index
     where embedding is not null
     order by updated_at desc
     limit ${NODE_LIMIT}
  `);

  const nodes: OrbitNode[] = [...nodeRows].map((r) => {
    const refs = Array.isArray(r.project_refs) ? (r.project_refs as string[]) : [];
    return {
      id: r.id,
      kind: r.kind,
      title: r.title.slice(0, 120),
      href: r.href,
      group: r.area_ref ?? refs[0] ?? null,
    };
  });

  // k-NN edges within the capped set: for each node, its NEIGHBORS closest
  // peers under MAX_DIST, de-duplicated to undirected pairs.
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
