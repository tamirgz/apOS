"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrbitGraph as Graph, OrbitNode, OrbitRegion } from "../queries";

// One colour per source kind — the legend and the stars share this map.
const KIND_COLORS: Record<string, string> = {
  knowledge: "#f0abfc",
  vault: "#34d399",
  note: "#7dd3fc",
  task: "#ffb454",
  idea: "#ffd43b",
  project: "#c04bff",
  feature: "#c084fc",
  person: "#f472b6",
  mail: "#60a5fa",
  event: "#22d3ee",
  telegram: "#38bdf8",
  report: "#fb7185",
  notion: "#a78bfa",
  memory: "#94a3b8",
  inbox: "#fbbf24",
  file: "#5eead4",
  ask: "#818cf8",
  workbench: "#fca5a5",
  attention: "#f87171",
};
const colorFor = (k: string) => KIND_COLORS[k] ?? "#8aa0b3";
const DIM = "#2b3440";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A link endpoint is a string id at first, then the node object after render.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const linkEnd = (v: any): string => (typeof v === "object" && v ? v.id : v);

// One distinct colour per topic cluster (the semantic map colours by cluster).
const CLUSTER_PALETTE = [
  "#60a5fa",
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#22d3ee",
  "#fb7185",
  "#84cc16",
  "#c084fc",
  "#fb923c",
  "#2dd4bf",
  "#e879f9",
];
const clusterColor = (id: number | null | undefined) =>
  id == null
    ? "#5b6673"
    : CLUSTER_PALETTE[((id % CLUSTER_PALETTE.length) + CLUSTER_PALETTE.length) % CLUSTER_PALETTE.length];

/* eslint-disable @typescript-eslint/no-explicit-any */
type XY = { x: number; y: number };

// Convex hull (Andrew's monotone chain) → ordered boundary points.
function convexHull(pts: XY[]): XY[] {
  if (pts.length < 3) return pts;
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: XY, a: XY, b: XY) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: XY[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: XY[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// A thin territory OUTLINE — the region's expanded convex hull. Minimal, not glowy.
function makeOutline(THREE: any, hex: string, hull: XY[], cx: number, cy: number) {
  const pad = 1.12; // small breathing room around the cloud
  const pts = hull.map(
    (h) => new THREE.Vector3(cx + (h.x - cx) * pad, cy + (h.y - cy) * pad, 0),
  );
  if (pts.length) pts.push(pts[0]);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.28 });
  return new THREE.Line(geo, mat);
}

// Thin territory outlines + topic labels for the semantic map.
function buildAtlasObjects(
  THREE: any,
  SpriteText: any,
  scene: any,
  regions: OrbitRegion[],
  members: Map<number, GNode[]>,
  color: (id: number) => string,
) {
  const objs: any[] = [];
  for (const r of regions) {
    const pts = (members.get(r.id) ?? [])
      .filter((n) => n.mx != null)
      .map((n) => ({ x: n.mx as number, y: n.my ?? 0 }));
    if (pts.length >= 3) {
      const outline = makeOutline(THREE, color(r.id), convexHull(pts), r.cx, r.cy);
      outline.position.z = -1;
      scene.add(outline);
      objs.push(outline);
    }
    const lbl = new SpriteText(r.label);
    lbl.color = "#eef4fb";
    lbl.textHeight = 10;
    lbl.fontWeight = "600";
    lbl.backgroundColor = "rgba(6,10,16,0.55)";
    lbl.padding = 2;
    lbl.position.set(r.cx, r.cy, 4);
    scene.add(lbl);
    objs.push(lbl);
  }
  return objs;
}

function clearAtlasObjects(scene: any, objs: any[]) {
  for (const o of objs) {
    scene.remove(o);
    o.material?.map?.dispose?.();
    o.material?.dispose?.();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type Mode = "constellation" | "semantic";
type GNode = OrbitNode & {
  val: number;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
};

export function OrbitGraph({ data }: { data: Graph }) {
  const router = useRouter();
  const holderRef = useRef<HTMLDivElement>(null);
  // Overlay for per-node labels that appear when you zoom into the map.
  const labelLayerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  // Three.js constructors, stashed from the dynamic import for the data effect.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const libsRef = useRef<{ THREE: any; SpriteText: any } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atlasObjsRef = useRef<any[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("constellation");
  const [query, setQuery] = useState("");
  // Semantic-search results: a set of matching node ids (null = title-match mode).
  const [semanticIds, setSemanticIds] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  // Insights panel: which tab, and the focused topic / bridge (for highlighting).
  const [panelTab, setPanelTab] = useState<"topics" | "bridges" | "kinds">("topics");
  const [activeRegion, setActiveRegion] = useState<number | null>(null);
  const [activeBridge, setActiveBridge] = useState<string | null>(null);
  // The mode the current layout was built for — lets us tell a real layout
  // change (mode switch) apart from a mere filter toggle.
  const lastLayoutMode = useRef<Mode | null>(null);
  // Current mode for the (stable) node-label accessor to read without re-init.
  const modeRef = useRef<Mode>("constellation");
  modeRef.current = mode;
  // Current query for the (stable) colour accessor to read without re-init.
  const queryRef = useRef("");
  queryRef.current = query.trim().toLowerCase();

  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of data.nodes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  // Stable node objects (the sim mutates x/y/z), sized by degree; the top hubs
  // get an always-on label.
  const { allNodes, hubIds } = useMemo(() => {
    const deg = new Map<string, number>();
    for (const l of data.links) {
      deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
      deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
    }
    const nodes: GNode[] = data.nodes.map((n) => ({
      ...n,
      val: 1 + Math.min(6, (deg.get(n.id) ?? 0) * 0.5),
    }));
    const hubs = new Set(
      [...deg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 26)
        .map(([id]) => id),
    );
    return { allNodes: nodes, hubIds: hubs };
  }, [data]);

  // Assign each placed node to its nearest topic region, and derive the members
  // per region + the cross-topic "bridges" (links whose ends are in different
  // regions). All client-side from the atlas centroids — no extra server data.
  const { nodeRegion, regionMembers, bridges } = useMemo(() => {
    const regionIds = new Set(data.regions.map((r) => r.id));
    const nodeRegion = new Map<string, number>();
    const regionMembers = new Map<number, GNode[]>();
    for (const r of data.regions) regionMembers.set(r.id, []);
    // Exact membership from the atlas cluster assignment (not nearest-centroid).
    for (const n of allNodes) {
      if (n.cluster == null || !regionIds.has(n.cluster)) continue;
      nodeRegion.set(n.id, n.cluster);
      regionMembers.get(n.cluster)!.push(n);
    }
    const lid = (v: unknown): string =>
      typeof v === "object" && v ? (v as { id: string }).id : (v as string);
    const pairs = new Map<string, { a: number; b: number; count: number }>();
    for (const l of data.links) {
      const ra = nodeRegion.get(lid(l.source));
      const rb = nodeRegion.get(lid(l.target));
      if (ra == null || rb == null || ra === rb) continue;
      const a = Math.min(ra, rb);
      const b = Math.max(ra, rb);
      const key = `${a}|${b}`;
      const e = pairs.get(key) ?? { a, b, count: 0 };
      e.count++;
      pairs.set(key, e);
    }
    const bridges = [...pairs.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 12);
    return { nodeRegion, regionMembers, bridges };
  }, [allNodes, data.regions, data.links]);

  const regionLabel = (id: number) =>
    data.regions.find((r) => r.id === id)?.label ?? `topic ${id}`;

  // What counts as "highlighted": a semantic-search hit when a search has run,
  // otherwise a live title-substring match. Held in a ref so the stable graph
  // accessors read the latest predicate without re-init.
  // Refs so the stable graph accessors read the latest focus without re-init.
  const nodeRegionRef = useRef(nodeRegion);
  nodeRegionRef.current = nodeRegion;
  const activeBridgeRef = useRef<string | null>(null);
  activeBridgeRef.current = activeBridge;
  const highlightRef = useRef<(n: GNode) => boolean>(() => true);
  highlightRef.current = (n) => {
    if (semanticIds) return semanticIds.has(n.id);
    if (activeBridge) {
      const [a, b] = activeBridge.split("|").map(Number);
      const r = nodeRegion.get(n.id);
      return r === a || r === b;
    }
    if (activeRegion != null) return nodeRegion.get(n.id) === activeRegion;
    return !queryRef.current || n.title.toLowerCase().includes(queryRef.current);
  };
  const matches = (n: GNode) => highlightRef.current(n);

  // Fly the camera to a node (used by search + node click).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flyTo = (g: any, n: GNode) => {
    const r = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0) || 1;
    g.cameraPosition(
      {
        x: (n.x ?? 0) * (1 + 120 / r),
        y: (n.y ?? 0) * (1 + 120 / r),
        z: (n.z ?? 0) * (1 + 120 / r),
      },
      n,
      900,
    );
  };

  // Semantic search: embed the query server-side, highlight the nearest nodes,
  // fly to the top hit. Runs on submit (Enter) — never per keystroke.
  const runSemantic = async () => {
    const q = query.trim();
    if (!q) {
      setSemanticIds(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/orbit/search?q=${encodeURIComponent(q)}`);
      const { hits } = (await res.json()) as { hits: { id: string }[] };
      const ids = new Set(hits.map((h) => h.id));
      setSemanticIds(ids);
      const g = graphRef.current;
      const top = g?.graphData().nodes.find((n: GNode) => n.id === hits[0]?.id);
      if (g && top) flyTo(g, top);
    } catch {
      /* leave the current highlight as-is on failure */
    } finally {
      setSearching(false);
    }
  };

  // Init once.
  useEffect(() => {
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let g: any;
    let onResize: (() => void) | undefined;
    (async () => {
      const [{ default: ForceGraph3D }, { default: SpriteText }, THREE] =
        await Promise.all([
          import("3d-force-graph"),
          import("three-spritetext"),
          import("three"),
        ]);
      if (disposed || !holderRef.current) return;
      libsRef.current = { THREE, SpriteText };
      const el = holderRef.current;
      g = new ForceGraph3D(el, { controlType: "orbit" });
      g.backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false)
        .nodeRelSize(4)
        .nodeVal((n: GNode) => n.val)
        .nodeColor((n: GNode) => {
          if (!matches(n)) return DIM;
          // Semantic map colours by topic cluster; constellation by source kind.
          if (modeRef.current === "semantic") {
            const rid = nodeRegionRef.current.get(n.id);
            return rid != null ? clusterColor(rid) : "#5b6673";
          }
          return colorFor(n.kind);
        })
        .nodeOpacity(0.92)
        .nodeLabel(
          (n: GNode) =>
            `<div style="padding:4px 8px;border-radius:8px;background:rgba(10,16,24,.9);border:1px solid ${colorFor(
              n.kind,
            )}55;color:#e8f2f0;font:12px/1.4 ui-sans-serif,system-ui;max-width:280px">` +
            `<span style="color:${colorFor(n.kind)};font-family:ui-monospace,monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase">${esc(
              n.kind,
            )}</span><br>${esc(n.title)}</div>`,
        )
        .nodeThreeObjectExtend(true)
        .nodeThreeObject((n: GNode) => {
          // Hub labels clutter the semantic map — show them in constellation only.
          if (modeRef.current === "semantic" || !hubIds.has(n.id)) return undefined;
          const s = new SpriteText(n.title.slice(0, 26));
          s.color = matches(n) ? "#dfeaf5" : DIM;
          s.textHeight = 5;
          s.backgroundColor = "rgba(8,12,18,0.6)";
          s.padding = 1.5;
          (s as unknown as { position: { y: number } }).position.y = 9;
          return s;
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .linkColor((l: any) => {
          // Bridge focus: light up the cross-topic links, mute the rest.
          if (activeBridgeRef.current) {
            const [a, b] = activeBridgeRef.current.split("|").map(Number);
            const ra = nodeRegionRef.current.get(linkEnd(l.source));
            const rb = nodeRegionRef.current.get(linkEnd(l.target));
            return (ra === a && rb === b) || (ra === b && rb === a)
              ? "rgba(255,214,110,0.9)"
              : "rgba(130,180,235,0.04)";
          }
          const t = Math.max(0, Math.min(1, 1 - (l.dist ?? 0.4) / 0.5));
          const aa = (0.28 + 0.42 * t).toFixed(2);
          return `rgba(130,180,235,${aa})`;
        })
        .linkWidth(0.8)
        .linkOpacity(0.7)
        .width(el.clientWidth || 800)
        .height(el.clientHeight || 600)
        .onNodeClick((n: GNode) => {
          if (n.href && /^\/m\//.test(n.href)) {
            router.push(n.href);
            return;
          }
          const r = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0) || 1;
          g.cameraPosition(
            {
              x: (n.x ?? 0) * (1 + 120 / r),
              y: (n.y ?? 0) * (1 + 120 / r),
              z: (n.z ?? 0) * (1 + 120 / r),
            },
            n,
            800,
          );
        });
      graphRef.current = g;

      try {
        g.d3Force("charge")?.strength(-32);
        g.d3Force("link")?.distance(26);
      } catch {
        /* forces not ready — defaults are fine */
      }

      const controls = g.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.5;

      onResize = () => {
        if (!holderRef.current) return;
        g.width(holderRef.current.clientWidth).height(
          holderRef.current.clientHeight,
        );
      };
      window.addEventListener("resize", onResize);
      const ro = new ResizeObserver(() => onResize?.());
      ro.observe(el);
      (g.__ro as ResizeObserver) = ro;

      let fitted = false;
      const fit = () => {
        if (disposed || fitted) return;
        onResize?.();
        if ((holderRef.current?.clientWidth ?? 0) > 0) {
          fitted = true;
          try {
            g.zoomToFit(700, 40);
          } catch {
            /* ignore */
          }
        }
      };
      setTimeout(fit, 1500);
      setTimeout(fit, 3500);

      if (!disposed) setReady(true);
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      if (g) {
        try {
          g.__ro?.disconnect?.();
          clearAtlasObjects(g.scene?.() ?? { remove() {} }, atlasObjsRef.current);
          atlasObjsRef.current = [];
          g._destructor?.();
        } catch {
          /* best effort */
        }
      }
      graphRef.current = null;
    };
  }, [router, hubIds]);

  // Feed data + apply the layout mode whenever inputs change.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const semantic = mode === "semantic";
    // A mode switch rebuilds the layout; a plain filter toggle must NOT — it
    // should hide/show in place with zero re-scatter or camera move.
    const layoutChanged = lastLayoutMode.current !== mode;
    const visible = allNodes.filter((n) => !hidden.has(n.kind));

    if (semantic) {
      // Flat 2D embedding map: pin every node onto the z = 0 plane at its
      // projection coordinate.
      for (const n of allNodes) {
        if (n.mx != null) {
          n.fx = n.mx;
          n.fy = n.my ?? 0;
          n.fz = 0;
        }
      }
    } else if (layoutChanged) {
      // Entering constellation: release the pins and re-seed a small random 3D
      // position for every node. Coming from the flat 2D map they all sit at
      // z = 0, and with zero z-variance the symmetric forces can never lift them
      // off the plane — so the sim would stay flat unless we seed the spread.
      for (const n of allNodes) {
        n.fx = undefined;
        n.fy = undefined;
        n.fz = undefined;
        n.x = (Math.random() - 0.5) * 120;
        n.y = (Math.random() - 0.5) * 120;
        n.z = (Math.random() - 0.5) * 120;
      }
    } else {
      // Filter toggle within constellation: FREEZE each node where it currently
      // sits (graphData() re-warms the sim, which would otherwise push nodes
      // apart and shrink the whole view every time a kind is toggled).
      for (const n of allNodes) {
        if (n.x != null) {
          n.fx = n.x;
          n.fy = n.y;
          n.fz = n.z;
        }
      }
    }

    const ids = new Set(visible.map((n) => n.id));
    // 3d-force-graph rewrites link.source/target from the string id to the node
    // OBJECT on first render, so read the id either way — and hand it fresh copies
    // each time so it never mutates our source-of-truth `data.links`.
    const sid = (v: unknown): string =>
      typeof v === "object" && v ? (v as { id: string }).id : (v as string);
    let links = data.links
      .filter((l) => ids.has(sid(l.source)) && ids.has(sid(l.target)))
      .map((l) => ({ source: sid(l.source), target: sid(l.target), dist: l.dist }));
    // Semantic map: keep only the CLOSEST links — faint, local connective tissue.
    // The long cross-map links are the hairball; position already shows the rest.
    if (semantic) links = links.filter((l) => l.dist < 0.25);

    g.nodeRelSize(semantic ? 1.8 : 4);
    g.linkWidth(semantic ? 0.3 : 0.8);
    g.linkOpacity(semantic ? 0.07 : 0.7);
    g.graphData({ nodes: visible, links });

    // Only reshape the camera/controls (and the atlas overlay) on an actual mode
    // switch — never on a filter toggle.
    if (layoutChanged) {
      // Semantic overlay: soft topic territories + labels. Rebuild on entry,
      // remove entirely in constellation.
      const scene = g.scene?.();
      const libs = libsRef.current;
      if (scene) {
        clearAtlasObjects(scene, atlasObjsRef.current);
        atlasObjsRef.current =
          semantic && libs
            ? buildAtlasObjects(
                libs.THREE,
                libs.SpriteText,
                scene,
                data.regions,
                regionMembers,
                clusterColor,
              )
            : [];
      }
      // Toggle hub labels (accessor reads modeRef): on in constellation, off here.
      g.nodeThreeObject(g.nodeThreeObject());

      const c = g.controls();
      if (semantic) {
        // Lock to a flat top-down 2D map: no rotation, left-drag pans.
        c.autoRotate = false;
        c.enableRotate = false;
        c.mouseButtons.LEFT = 2; // THREE.MOUSE.PAN
        g.cameraPosition({ x: 0, y: 0, z: 600 }, { x: 0, y: 0, z: 0 }, 0);
      } else {
        c.autoRotate = true;
        c.enableRotate = true;
        c.mouseButtons.LEFT = 0; // THREE.MOUSE.ROTATE
        g.d3ReheatSimulation?.();
      }
      setTimeout(() => {
        try {
          g.zoomToFit(600, semantic ? 60 : 50);
        } catch {
          /* ignore */
        }
      }, semantic ? 300 : 1200);
    }
    lastLayoutMode.current = mode;
  }, [allNodes, data.links, data.regions, regionMembers, hidden, ready, mode]);

  // Re-highlight (nodes + links + labels) on any focus change, without rebuilding.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.nodeColor(g.nodeColor());
    g.linkColor(g.linkColor());
    g.nodeThreeObject(g.nodeThreeObject());
  }, [query, semanticIds, activeRegion, activeBridge, ready]);

  // Per-node labels that fade in as you zoom into the map: on the flat 2D view,
  // when the camera drops below a height threshold, label the most-connected
  // items currently in view (an HTML overlay, repositioned on pan/zoom).
  useEffect(() => {
    const g = graphRef.current;
    const layer = labelLayerRef.current;
    if (!g || !layer) return;
    if (mode !== "semantic") {
      layer.innerHTML = "";
      return;
    }
    let raf = 0;
    const render = () => {
      raf = 0;
      const camZ = g.camera()?.position?.z ?? 999;
      // Only when zoomed in; fade the cap up the closer you get.
      if (camZ > 360) {
        layer.innerHTML = "";
        return;
      }
      const cap = camZ < 160 ? 80 : camZ < 260 ? 48 : 26;
      const w = layer.clientWidth;
      const h = layer.clientHeight;
      const cand: { n: GNode; x: number; y: number }[] = [];
      for (const n of g.graphData().nodes as GNode[]) {
        if (n.x == null) continue;
        const s = g.graph2ScreenCoords(n.x, n.y ?? 0, n.z ?? 0);
        if (!s || s.x < 0 || s.x > w || s.y < 0 || s.y > h) continue;
        cand.push({ n, x: s.x, y: s.y });
      }
      cand.sort((a, b) => (b.n.val ?? 0) - (a.n.val ?? 0));
      layer.innerHTML = cand
        .slice(0, cap)
        .map(
          ({ n, x, y }) =>
            `<div style="position:absolute;left:${x.toFixed(0)}px;top:${y.toFixed(
              0,
            )}px;transform:translate(-50%,-150%);font:10px/1.2 ui-sans-serif,system-ui;color:#dce7f3;text-shadow:0 1px 3px #000,0 0 2px #000;white-space:nowrap">${esc(
              n.title.slice(0, 32),
            )}</div>`,
        )
        .join("");
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(render);
    };
    const controls = g.controls();
    controls.addEventListener("change", schedule);
    schedule();
    return () => {
      controls.removeEventListener("change", schedule);
      if (raf) cancelAnimationFrame(raf);
      layer.innerHTML = "";
    };
  }, [mode, ready]);

  const openNode = (n: GNode) => {
    if (n.href && /^\/m\//.test(n.href)) {
      router.push(n.href);
      return;
    }
    const g = graphRef.current;
    if (g) flyTo(g, n);
  };

  const frameAt = (cx: number, cy: number, z: number) => {
    const g = graphRef.current;
    if (g) g.cameraPosition({ x: cx, y: cy, z }, { x: cx, y: cy, z: 0 }, 800);
  };

  // Focus a topic: highlight its members, frame it (switching to the map first).
  const focusTopic = (rid: number) => {
    const r = data.regions.find((x) => x.id === rid);
    setActiveBridge(null);
    setActiveRegion((cur) => (cur === rid ? null : rid));
    if (!r) return;
    const doFrame = () => frameAt(r.cx, r.cy, Math.max(220, r.r * 3));
    if (mode !== "semantic") {
      setMode("semantic");
      setTimeout(doFrame, 700);
    } else doFrame();
  };

  // Focus a bridge: light up the cross-links, frame both territories.
  const focusBridge = (key: string, a: number, b: number) => {
    const ra = data.regions.find((x) => x.id === a);
    const rb = data.regions.find((x) => x.id === b);
    setActiveRegion(null);
    setActiveBridge((cur) => (cur === key ? null : key));
    if (!ra || !rb) return;
    const cx = (ra.cx + rb.cx) / 2;
    const cy = (ra.cy + rb.cy) / 2;
    const span = Math.hypot(ra.cx - rb.cx, ra.cy - rb.cy) + Math.max(ra.r, rb.r) * 2;
    const doFrame = () => frameAt(cx, cy, Math.max(260, span * 1.1));
    if (mode !== "semantic") {
      setMode("semantic");
      setTimeout(doFrame, 700);
    } else doFrame();
  };

  const toggle = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const shownCount = allNodes.filter((n) => !hidden.has(n.kind)).length;

  return (
    <div className="relative h-[calc(100vh-8.5rem)] overflow-hidden rounded-2xl glass">
      <div ref={holderRef} className="absolute inset-0" />
      <div
        ref={labelLayerRef}
        className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      />

      {/* header + mode + search */}
      <div className="absolute left-4 top-4 z-10 w-64">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
          knowledge orbit
        </div>
        <div className="mt-1 text-sm text-ink-dim">
          <span className="text-ink">{shownCount}</span> of {data.total} nodes ·{" "}
          {data.links.length} links
          {data.regions.length > 0 ? ` · ${data.regions.length} topics` : ""}
        </div>

        <div className="mt-3 inline-flex rounded-lg glass p-0.5 text-xs">
          {(["constellation", "semantic"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2.5 py-1 capitalize transition ${
                mode === m
                  ? "bg-ion/20 text-ion"
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {m === "semantic" ? "semantic map" : "constellation"}
            </button>
          ))}
        </div>
        <p className="mt-1.5 max-w-[15rem] text-[11px] leading-snug text-ink-faint">
          {mode === "semantic"
            ? "A flat 2D map placed by meaning — nearby stars share a topic."
            : "Placed by connection — linked stars pull together."}
        </p>
        {mode === "semantic" && data.regions.length === 0 ? (
          <p className="mt-1 max-w-[15rem] text-[11px] leading-snug text-amber-300/70">
            Topic map is still building in the background — check back in a moment.
          </p>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSemantic();
          }}
          className="relative mt-2"
        >
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (semanticIds) setSemanticIds(null);
            }}
            placeholder="Search by meaning… (press Enter)"
            className="h-8 w-full rounded-lg glass px-2.5 pr-12 text-xs text-ink outline-none placeholder:text-ink-faint focus:glass-edge"
          />
          {searching ? (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-ink-faint">
              …
            </span>
          ) : semanticIds ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSemanticIds(null);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ion hover:underline"
            >
              clear
            </button>
          ) : null}
        </form>
        {semanticIds ? (
          <p className="mt-1 text-[11px] leading-snug text-ink-faint">
            {semanticIds.size} closest by meaning — highlighted, flew to the top hit.
          </p>
        ) : null}
      </div>

      {/* insights panel — topics · bridges · kinds */}
      <div className="absolute right-4 top-4 z-10 flex max-h-[84%] w-52 flex-col rounded-xl glass p-2.5">
        <div className="mb-2 flex gap-1 text-[10px]">
          {(["topics", "bridges", "kinds"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setPanelTab(t);
                if (t === "kinds") {
                  setActiveRegion(null);
                  setActiveBridge(null);
                }
              }}
              className={`flex-1 rounded-md px-1.5 py-1 capitalize transition ${
                panelTab === t
                  ? "bg-ion/20 text-ion"
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {panelTab === "topics" ? (
            data.regions.length === 0 ? (
              <p className="px-1 py-2 text-[11px] leading-snug text-ink-faint">
                Topics are still being mapped in the background.
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                <p className="px-1 pb-1 text-[10px] leading-snug text-ink-faint">
                  Click a topic to zoom in and list its items.
                </p>
                {[...data.regions]
                  .sort((a, b) => b.count - a.count)
                  .map((r) => {
                    const active = activeRegion === r.id;
                    const mem = regionMembers.get(r.id) ?? [];
                    return (
                      <div key={r.id}>
                        <button
                          type="button"
                          onClick={() => focusTopic(r.id)}
                          className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition ${
                            active ? "bg-white/10" : "hover:bg-white/6"
                          }`}
                        >
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: clusterColor(r.id) }}
                          />
                          <span className="flex-1 truncate text-ink-dim">{r.label}</span>
                          <span className="font-mono text-[9px] text-ink-faint">
                            {r.count}
                          </span>
                        </button>
                        {active ? (
                          <div className="mb-1 ml-3.5 mt-0.5 max-h-44 overflow-y-auto border-l border-white/10 pl-2">
                            {mem.slice(0, 24).map((n) => (
                              <button
                                key={n.id}
                                type="button"
                                title={n.title}
                                onClick={() => openNode(n)}
                                className="block w-full truncate py-0.5 text-left text-[11px] text-ink-faint transition hover:text-ink"
                              >
                                {n.title}
                              </button>
                            ))}
                            {mem.length > 24 ? (
                              <div className="py-0.5 text-[10px] text-ink-faint">
                                +{mem.length - 24} more
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
              </div>
            )
          ) : null}

          {panelTab === "bridges" ? (
            bridges.length === 0 ? (
              <p className="px-1 py-2 text-[11px] leading-snug text-ink-faint">
                No cross-topic links yet.
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                <p className="px-1 pb-1 text-[10px] leading-snug text-ink-faint">
                  Topics tied together by related items — click to light up the links.
                </p>
                {bridges.map((b) => {
                  const active = activeBridge === b.key;
                  return (
                    <button
                      key={b.key}
                      type="button"
                      onClick={() => focusBridge(b.key, b.a, b.b)}
                      className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                        active ? "bg-white/10" : "hover:bg-white/6"
                      }`}
                    >
                      <span className="flex-1 text-[11px] leading-tight text-ink-dim">
                        {regionLabel(b.a)}
                        <span className="text-ink-faint"> ↔ </span>
                        {regionLabel(b.b)}
                      </span>
                      <span className="font-mono text-[9px] text-ink-faint">
                        {b.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )
          ) : null}

          {panelTab === "kinds" ? (
            <div className="flex flex-col gap-0.5">
              <p className="px-1 pb-1 text-[10px] leading-snug text-ink-faint">
                Click to hide / show a source kind.
              </p>
              {kinds.map(([k, n]) => {
                const off = hidden.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggle(k)}
                    className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition hover:bg-white/6 ${
                      off ? "opacity-35" : ""
                    }`}
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: colorFor(k) }}
                    />
                    <span className="flex-1 truncate text-ink-dim">{k}</span>
                    <span className="font-mono text-[9px] text-ink-faint">{n}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
        {mode === "semantic"
          ? "drag to pan · scroll to zoom · click a node to open"
          : "drag to orbit · scroll to zoom · click a node to open"}
      </div>
    </div>
  );
}
