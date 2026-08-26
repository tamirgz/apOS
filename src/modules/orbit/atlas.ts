/**
 * The semantic ATLAS — the expensive half of the Orbit graph, computed OFF the
 * render path. It lays the whole corpus out as a force-directed knowledge graph
 * (ForceAtlas2 over the k-NN edges — the layout that actually reveals community
 * structure and fills space, unlike a UMAP scatter), detects topic communities
 * (Louvain), and NAMES the big ones with a local LLM (qwen). That costs tens of
 * seconds, so a background job builds it, persists it to app_settings, and only
 * rebuilds when the corpus fingerprint changes (idempotent). The page reads the
 * persisted result instantly.
 *
 * Persisting the LAYOUT (not just the names) is also correctness: ForceAtlas2 is
 * stochastic, so a fresh render-time layout would place nodes differently from
 * the naming run and the labelled territories would float over the wrong groups.
 * One build, one layout, shared by all readers.
 */
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/app-settings";

export interface OrbitRegion {
  id: number;
  label: string;
  cx: number;
  cy: number;
  r: number;
  kind: string;
  count: number;
}

export interface OrbitLink {
  source: string;
  target: string;
  dist: number;
}

interface AtlasBlob {
  fingerprint: string;
  builtAt: string;
  /** id → [mx, my] in the force-directed layout. */
  positions: Record<string, [number, number]>;
  /** id → region rank (0..N-1) for a top community, else -1. */
  clusters: Record<string, number>;
  regions: OrbitRegion[];
  /** Compact [source, target, dist] tuples — the k-NN edges. */
  links: [string, string, number][];
}

export interface Atlas {
  positions: Map<string, [number, number]>;
  clusters: Map<string, number>;
  regions: OrbitRegion[];
  links: OrbitLink[];
  builtAt: string;
}

const ATLAS_KEY = "orbit_atlas";
const ATLAS_LIMIT = 3000; // safety ceiling on nodes we lay out
const MAP_SCALE = 300; // half-extent of the map, in scene units
const TOP_REGIONS = 12; // how many communities to name + outline
const MIN_REGION = 12; // ignore communities smaller than this
const NEIGHBORS = 6; // k-NN edges per node
const MAX_DIST = 0.5; // the app's "genuinely related" cosine-distance gate

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const NAMER_MODEL = "qwen3:8b";

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)))];
};

const modeOf = (xs: string[]): string => {
  const m = new Map<string, number>();
  for (const v of xs) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

/** Deterministic 2D k-means (seeded by an even sweep) — partitions the laid-out
 *  positions into contiguous, space-filling colour regions. */
function kmeans2d(
  pts: { x: number; y: number }[],
  k: number,
  iters = 16,
): { assign: number[]; cent: { x: number; y: number }[] } {
  const n = pts.length;
  const order = [...pts.keys()].sort((a, b) => pts[a].x + pts[a].y - (pts[b].x + pts[b].y));
  const cent = Array.from({ length: k }, (_, i) => {
    const p = pts[order[Math.floor((i * (n - 1)) / Math.max(1, k - 1))]];
    return { x: p.x, y: p.y };
  });
  const assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let bd = Infinity;
      let bj = 0;
      for (let j = 0; j < k; j++) {
        const d = (pts[i].x - cent[j].x) ** 2 + (pts[i].y - cent[j].y) ** 2;
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      assign[i] = bj;
    }
    const sx = new Array(k).fill(0);
    const sy = new Array(k).fill(0);
    const cn = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      sx[assign[i]] += pts[i].x;
      sy[assign[i]] += pts[i].y;
      cn[assign[i]]++;
    }
    for (let j = 0; j < k; j++) if (cn[j]) cent[j] = { x: sx[j] / cn[j], y: sy[j] / cn[j] };
  }
  return { assign, cent };
}

/** Map a coordinate axis into the scene box via a tanh squash around the median
 *  (no hard clamp — a clamp piled outliers onto the box edge). */
function makeNorm(vals: number[]) {
  const mid = pct(vals, 50);
  const scale = (pct(vals, 90) - pct(vals, 10)) / 2 || 1;
  return (v: number) => Math.tanh((v - mid) / (1.5 * scale)) * MAP_SCALE;
}

/** Ask the local model to name each community from a handful of its titles. */
async function nameRegions(
  clusters: { i: number; titles: string[] }[],
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (!clusters.length) return names;
  const list = clusters
    .map(
      (c) =>
        `${c.i}. ${c.titles.slice(0, 8).map((t) => t.replace(/\s+/g, " ").slice(0, 60)).join(" · ")}`,
    )
    .join("\n");
  const system =
    "You label clusters of a person's notes/tasks/messages with a SHORT topic name (2–4 words), in English, capturing what the items are ABOUT across any language. Reply with ONLY a JSON object mapping each cluster number to its name — no prose.";
  const user = `CLUSTERS (number. sample items):\n${list}\n\nReply like {"0":"Investment research","1":"Trip planning",…}`;
  try {
    const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NAMER_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return names;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const txt = (data.choices?.[0]?.message?.content ?? "").replace(
      /<think>[\s\S]*?<\/think>/gi,
      "",
    );
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return names;
    const obj = JSON.parse(m[0]) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(k);
      if (Number.isFinite(n) && typeof v === "string" && v.trim())
        names.set(n, v.trim().slice(0, 40));
    }
  } catch {
    /* Ollama down / slow — fall back to kind labels. */
  }
  return names;
}

async function corpusFingerprint(): Promise<string> {
  const row = await db.execute<{ n: number; mx: string | null }>(
    dsql`select count(*)::int as n, max(updated_at)::text as mx
           from search_index where embedding is not null`,
  );
  const r = [...row][0];
  return `${r?.n ?? 0}:${r?.mx ?? ""}`;
}

/** The k-NN edges over the corpus — each node to its nearest neighbours under
 *  the "genuinely related" cosine gate. */
async function fetchLinks(): Promise<[string, string, number][]> {
  const rows = [
    ...(await db.execute<{ source: string; target: string; dist: number }>(dsql`
      with picked as (
        select id, embedding from search_index
         where embedding is not null
         order by updated_at desc
         limit ${ATLAS_LIMIT}
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
    `)),
  ];
  return rows.map((r) => [r.source, r.target, Number(r.dist)]);
}

/** Build the atlas from scratch: layout → communities → name. Heavy. */
async function build(fingerprint: string): Promise<AtlasBlob> {
  const rows = [
    ...(await db.execute<{ id: string; kind: string; title: string }>(dsql`
      select id::text as id, kind,
             coalesce(nullif(title, ''), '(untitled)') as title
        from search_index
       where embedding is not null
       order by updated_at desc
       limit ${ATLAS_LIMIT}
    `)),
  ];
  const links = await fetchLinks();
  const byId = new Map(rows.map((r) => [r.id, r]));

  const positions: Record<string, [number, number]> = {};
  const clusters: Record<string, number> = {};
  let regions: OrbitRegion[] = [];

  if (rows.length >= 4 && links.length) {
    // Force-directed layout over the k-NN graph.
    const g = new Graph({ type: "undirected" });
    let seed = 1;
    const rnd = () => {
      // deterministic-ish spread for initial positions
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const r of rows)
      g.addNode(r.id, { x: rnd() * 100 - 50, y: rnd() * 100 - 50 });
    for (const [s, t, d] of links)
      if (g.hasNode(s) && g.hasNode(t) && !g.hasEdge(s, t))
        g.addEdge(s, t, { weight: 1 - d });

    // Force-directed layout (ForceAtlas2) over the k-NN graph — dense, connected
    // and space-filling. Low scalingRatio + linLog keeps it compact rather than
    // a thin uniform disc; Barnes-Hut keeps it fast.
    const inferred = forceAtlas2.inferSettings(g);
    forceAtlas2.assign(g, {
      iterations: 400,
      settings: {
        ...inferred,
        barnesHutOptimize: true,
        linLogMode: true,
        outboundAttractionDistribution: false,
        adjustSizes: false,
        gravity: 1,
        scalingRatio: 2,
        slowDown: 3,
      },
    });
    const fx = (id: string) => g.getNodeAttribute(id, "x") as number;
    const fy = (id: string) => g.getNodeAttribute(id, "y") as number;

    // Normalise into the box (from connected nodes; isolated ones scattered so
    // they don't pile at the gravity centre).
    const connected = rows.filter((r) => g.degree(r.id) > 0);
    const nx = makeNorm(connected.map((r) => fx(r.id)));
    const ny = makeNorm(connected.map((r) => fy(r.id)));
    for (const r of rows) {
      positions[r.id] =
        g.degree(r.id) > 0
          ? [nx(fx(r.id)), ny(fy(r.id))]
          : [(rnd() * 2 - 1) * MAP_SCALE, (rnd() * 2 - 1) * MAP_SCALE];
    }

    // Partition the LAID-OUT positions with k-means → contiguous, space-filling
    // colour territories (a Voronoi split: no overlap, no gaps). Every node gets
    // a region; the layout already groups similar items, so the regions are
    // coherent topics.
    const { assign, cent } = kmeans2d(
      rows.map((r) => ({ x: positions[r.id][0], y: positions[r.id][1] })),
      TOP_REGIONS,
    );
    rows.forEach((r, i) => (clusters[r.id] = assign[i]));

    const raw = cent
      .map((c, k) => {
        const members = rows.filter((_, i) => assign[i] === k);
        if (members.length < MIN_REGION) return null;
        const cx = c.x;
        const cy = c.y;
        const dists = members.map((r) =>
          Math.hypot(positions[r.id][0] - cx, positions[r.id][1] - cy),
        );
        const near = members
          .map((r, j) => ({ r, d: dists[j] }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 8)
          .map((x) => x.r.title);
        return {
          i: k,
          cx,
          cy,
          r: Math.max(24, pct(dists, 80)),
          kind: modeOf(members.map((m) => m.kind)),
          count: members.length,
          titles: near,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c != null);

    const names = await nameRegions(raw.map((c) => ({ i: c.i, titles: c.titles })));
    regions = raw.map((c) => ({
      id: c.i,
      label: names.get(c.i) ?? c.kind,
      cx: c.cx,
      cy: c.cy,
      r: c.r,
      kind: c.kind,
      count: c.count,
    }));
  } else {
    for (const r of rows) {
      positions[r.id] = [0, 0];
      clusters[r.id] = -1;
    }
  }

  // Keep only links whose endpoints survived (both in the node set).
  const kept = links.filter(([s, t]) => byId.has(s) && byId.has(t));

  return {
    fingerprint,
    builtAt: new Date().toISOString(),
    positions,
    clusters,
    regions,
    links: kept,
  };
}

/**
 * Background job: rebuild the atlas only when the corpus changed. Idempotent —
 * a no-op run costs one COUNT query. Scheduled + run-on-boot from the manifest.
 */
export async function refreshAtlas(): Promise<void> {
  const fp = await corpusFingerprint();
  const existing = await getSetting(ATLAS_KEY);
  if (existing) {
    try {
      if ((JSON.parse(existing) as AtlasBlob).fingerprint === fp) return;
    } catch {
      /* corrupt — rebuild */
    }
  }
  const blob = await build(fp);
  await setSetting(ATLAS_KEY, JSON.stringify(blob));
}

/** Read the persisted atlas for the render path. Never computes. */
export async function readAtlas(): Promise<Atlas | null> {
  const raw = await getSetting(ATLAS_KEY);
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as AtlasBlob;
    return {
      positions: new Map(Object.entries(blob.positions)),
      clusters: new Map(Object.entries(blob.clusters ?? {})),
      regions: blob.regions ?? [],
      links: (blob.links ?? []).map(([source, target, dist]) => ({
        source,
        target,
        dist,
      })),
      builtAt: blob.builtAt,
    };
  } catch {
    return null;
  }
}
