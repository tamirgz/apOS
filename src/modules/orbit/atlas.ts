/**
 * The semantic ATLAS — the expensive half of the Orbit graph, computed OFF the
 * render path. Projecting every embedding to 2D (UMAP), carving it into topic
 * territories (k-means), and NAMING each territory with a local LLM (qwen) costs
 * tens of seconds and must never run when someone just opens the page. So a
 * background job builds it, persists it to app_settings, and only rebuilds when
 * the corpus fingerprint changes (change-detected, idempotent). The page reads
 * the persisted result instantly.
 *
 * Persisting the PROJECTION (not just the names) is also correctness, not just
 * speed: umap-js is stochastic, so a fresh render-time projection would place
 * points differently from the background naming run and the labelled halos would
 * float over the wrong clusters. One build, one layout, shared by both.
 */
import { sql as dsql } from "drizzle-orm";
import { UMAP } from "umap-js";
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
  /** id → [mx, my] on the flat 2D map. */
  positions: Record<string, [number, number]>;
  regions: OrbitRegion[];
  /** Compact [source, target, dist] tuples — the k-NN edges, precomputed. */
  links: [string, string, number][];
}

export interface Atlas {
  positions: Map<string, [number, number]>;
  regions: OrbitRegion[];
  links: OrbitLink[];
  builtAt: string;
}

const ATLAS_KEY = "orbit_atlas";
const ATLAS_LIMIT = 3000; // safety ceiling on nodes we project
const MAP_SCALE = 280; // half-extent of the semantic map, in scene units
const K_REGIONS = 10;
const MIN_REGION = 12;
const NEIGHBORS = 6; // k-NN edges per node
const MAX_DIST = 0.5; // the app's "genuinely related" cosine-distance gate

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const NAMER_MODEL = "qwen3:8b";

function parseVec(s: unknown): number[] {
  if (Array.isArray(s)) return s as number[];
  try {
    return JSON.parse(String(s));
  } catch {
    return [];
  }
}

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)))];
};

/**
 * Project embeddings to a flat 2D plane and spread them into the scene box.
 * Normalisation is a tanh squash around the median, not a hard clamp — a clamp
 * piled every outlier onto the box edge (the tell-tale straight rectangles);
 * tanh compresses the tails smoothly so strays fade toward the border instead.
 */
function project(vectors: number[][]): [number, number][] {
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(20, vectors.length - 1),
    minDist: 0.6,
    spread: 2.2,
    nEpochs: 400,
  });
  const coords = umap.fit(vectors);
  const mid = [0, 0];
  const scale = [1, 1];
  for (let a = 0; a < 2; a++) {
    const col = coords.map((c) => c[a]);
    mid[a] = pct(col, 50);
    scale[a] = (pct(col, 90) - pct(col, 10)) / 2 || 1;
  }
  const norm = (v: number, a: number) =>
    Math.tanh((v - mid[a]) / (1.5 * scale[a])) * MAP_SCALE;
  return coords.map((c) => [norm(c[0], 0), norm(c[1], 1)] as [number, number]);
}

interface Pt {
  x: number;
  y: number;
}

/** Deterministic 2D k-means (seeded by an even sweep, so the map is stable). */
function kmeans2d(pts: Pt[], k: number, iters = 14): { assign: number[]; cent: Pt[] } {
  const n = pts.length;
  const order = [...pts.keys()].sort((a, b) => pts[a].x + pts[a].y - (pts[b].x + pts[b].y));
  const cent: Pt[] = [];
  for (let i = 0; i < k; i++) {
    const p = pts[order[Math.floor((i * (n - 1)) / Math.max(1, k - 1))]];
    cent.push({ x: p.x, y: p.y });
  }
  const assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let bd = Infinity;
      let bj = 0;
      for (let j = 0; j < k; j++) {
        const dx = pts[i].x - cent[j].x;
        const dy = pts[i].y - cent[j].y;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      assign[i] = bj;
    }
    const sx = new Array(k).fill(0);
    const sy = new Array(k).fill(0);
    const cnt = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      sx[assign[i]] += pts[i].x;
      sy[assign[i]] += pts[i].y;
      cnt[assign[i]]++;
    }
    for (let j = 0; j < k; j++)
      if (cnt[j]) cent[j] = { x: sx[j] / cnt[j], y: sy[j] / cnt[j] };
  }
  return { assign, cent };
}

const modeOf = (xs: string[]): string => {
  const m = new Map<string, number>();
  for (const v of xs) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

/** Ask the local model to name each cluster from a handful of its titles. */
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
      // Background job — a generous budget, since nothing is waiting on it.
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

/** Build the atlas from scratch: project → cluster → name. Heavy. */
async function build(fingerprint: string): Promise<AtlasBlob> {
  const rows = [
    ...(await db.execute<{
      id: string;
      kind: string;
      title: string;
      embedding: unknown;
    }>(dsql`
      select id::text as id, kind,
             coalesce(nullif(title, ''), '(untitled)') as title,
             embedding::text as embedding
        from search_index
       where embedding is not null
       order by updated_at desc
       limit ${ATLAS_LIMIT}
    `)),
  ];

  const positions: Record<string, [number, number]> = {};
  let regions: OrbitRegion[] = [];
  if (rows.length >= 4) {
    const coords = project(rows.map((r) => parseVec(r.embedding)));
    rows.forEach((r, i) => (positions[r.id] = coords[i]));

    if (rows.length >= K_REGIONS * MIN_REGION) {
      const pts: Pt[] = coords.map(([x, y]) => ({ x, y }));
      const { assign, cent } = kmeans2d(pts, K_REGIONS);
      const members: number[][] = Array.from({ length: K_REGIONS }, () => []);
      assign.forEach((c, i) => members[c].push(i));

      const raw = members
        .map((idx, i) => {
          if (idx.length < MIN_REGION) return null;
          const c = cent[i];
          const dists = idx.map((j) => Math.hypot(pts[j].x - c.x, pts[j].y - c.y));
          const r = Math.max(30, pct(dists, 80));
          const near = idx
            .map((j, k) => ({ j, d: dists[k] }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 8)
            .map((x) => rows[x.j].title);
          return {
            i,
            cx: c.x,
            cy: c.y,
            r,
            kind: modeOf(idx.map((j) => rows[j].kind)),
            count: idx.length,
            titles: near,
          };
        })
        .filter(Boolean) as {
        i: number;
        cx: number;
        cy: number;
        r: number;
        kind: string;
        count: number;
        titles: string[];
      }[];

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
    }
  }

  // Precompute the k-NN edges here too, so the render path never runs the
  // (multi-second) LATERAL vector join.
  const linkRows = [
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
  const links: [string, string, number][] = linkRows.map((r) => [
    r.source,
    r.target,
    Number(r.dist),
  ]);

  return {
    fingerprint,
    builtAt: new Date().toISOString(),
    positions,
    regions,
    links,
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
      if ((JSON.parse(existing) as AtlasBlob).fingerprint === fp) return; // unchanged
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
