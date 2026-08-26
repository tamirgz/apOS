import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { readAtlas, type OrbitLink, type OrbitRegion } from "./atlas";

/** One node in the orbital graph — a row from the unified search_index. */
export interface OrbitNode {
  id: string;
  kind: string;
  title: string;
  href: string | null;
  /** Coarse cluster (area/project ref) if the item carries one. */
  group: string | null;
  /** Semantic-map position: the persisted 2D atlas projection. z is always 0
   *  (flat map). Null when the atlas hasn't placed this item yet. */
  mx: number | null;
  my: number | null;
  mz: number | null;
  /** Topic cluster (region id) from the atlas, or null if unplaced. */
  cluster: number | null;
}

export type { OrbitLink, OrbitRegion };

export interface OrbitGraph {
  nodes: OrbitNode[];
  links: OrbitLink[];
  regions: OrbitRegion[];
  total: number;
  /** When the semantic atlas was last rebuilt (null until the job has run). */
  atlasBuiltAt: string | null;
}

// Show the whole embedded corpus; the ceiling is a safety guard for very large
// vaults, not a display choice (the semantic layout is precomputed off-path).
const NODE_LIMIT = 3000;

/**
 * Build the interconnected graph over everything apOS has embedded — knowledge,
 * the Obsidian vault, notes, tasks, mail, events, people, projects, memory … —
 * from the single `search_index` vector space. Positions, named topic regions
 * AND links all come from the precomputed atlas (see atlas.ts) — this path only
 * lists the current nodes and reads the cache, so it stays fast (no vector join,
 * no UMAP, no LLM).
 */
export async function orbitGraph(): Promise<OrbitGraph> {
  // Mail + calendar are excluded from the graph (the mails that matter are
  // auto-analysed daily and already in the Obsidian vault).
  const excluded = dsql`kind not in ('mail', 'event')`;
  const totalRow = await db.execute<{ n: number }>(
    dsql`select count(*)::int as n from search_index
          where embedding is not null and ${excluded}`,
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
     where embedding is not null and ${excluded}
     order by updated_at desc
     limit ${NODE_LIMIT}
  `);
  const rows = [...nodeRows];

  const atlas = await readAtlas();

  const nodes: OrbitNode[] = rows.map((r) => {
    const refs = Array.isArray(r.project_refs) ? (r.project_refs as string[]) : [];
    const p = atlas?.positions.get(r.id) ?? null;
    const cl = atlas?.clusters.get(r.id);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title.slice(0, 120),
      href: r.href,
      group: r.area_ref ?? refs[0] ?? null,
      mx: p ? p[0] : null,
      my: p ? p[1] : null,
      mz: p ? 0 : null,
      cluster: cl ?? null,
    };
  });

  // Links come precomputed from the atlas; keep only those whose endpoints are
  // in the currently-listed node set.
  const present = new Set(nodes.map((n) => n.id));
  const links: OrbitLink[] = (atlas?.links ?? []).filter(
    (l) => present.has(l.source) && present.has(l.target),
  );

  return {
    nodes,
    links,
    regions: atlas?.regions ?? [],
    total,
    atlasBuiltAt: atlas?.builtAt ?? null,
  };
}
