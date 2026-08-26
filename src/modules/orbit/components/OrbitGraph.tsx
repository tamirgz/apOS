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

/* eslint-disable @typescript-eslint/no-explicit-any */
// A soft radial "territory" glow for a semantic-map region, tinted by kind.
function makeHalo(THREE: any, hex: string, radius: number) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, hex + "66");
  grad.addColorStop(0.55, hex + "22");
  grad.addColorStop(1, hex + "00");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sp = new THREE.Sprite(mat);
  const d = radius * 3.2; // cover the cloud, not just the core
  sp.scale.set(d, d, 1);
  return sp;
}

// Territory halos (behind) + topic labels (in front) for the semantic map.
function buildAtlasObjects(
  THREE: any,
  SpriteText: any,
  scene: any,
  regions: OrbitRegion[],
  color: (k: string) => string,
) {
  const objs: any[] = [];
  for (const r of regions) {
    const halo = makeHalo(THREE, color(r.kind), r.r);
    halo.position.set(r.cx, r.cy, -3);
    scene.add(halo);
    objs.push(halo);
    const lbl = new SpriteText(r.label);
    lbl.color = "#eef4fb";
    lbl.textHeight = 11;
    lbl.fontWeight = "600";
    lbl.backgroundColor = "rgba(6,10,16,0.5)";
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

  // What counts as "highlighted": a semantic-search hit when a search has run,
  // otherwise a live title-substring match. Held in a ref so the stable graph
  // accessors read the latest predicate without re-init.
  const highlightRef = useRef<(n: GNode) => boolean>(() => true);
  highlightRef.current = (n) =>
    semanticIds
      ? semanticIds.has(n.id)
      : !queryRef.current || n.title.toLowerCase().includes(queryRef.current);
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
        .nodeColor((n: GNode) => (matches(n) ? colorFor(n.kind) : DIM))
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
        .linkColor((l: { dist?: number }) => {
          const t = Math.max(0, Math.min(1, 1 - (l.dist ?? 0.4) / 0.5));
          const a = (0.28 + 0.42 * t).toFixed(2);
          return `rgba(130,180,235,${a})`;
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

    g.nodeRelSize(semantic ? 2.5 : 4);
    g.linkWidth(semantic ? 0.35 : 0.8);
    g.linkOpacity(semantic ? 0.08 : 0.7);
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
            ? buildAtlasObjects(libs.THREE, libs.SpriteText, scene, data.regions, colorFor)
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
  }, [allNodes, data.links, data.regions, hidden, ready, mode]);

  // Search → re-highlight (nodes + labels) without rebuilding the graph.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.nodeColor(g.nodeColor());
    g.nodeThreeObject(g.nodeThreeObject());
  }, [query, semanticIds, ready]);

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

      {/* legend / kind filter */}
      <div className="absolute right-4 top-4 z-10 max-h-[70%] w-40 overflow-y-auto rounded-xl glass p-2.5">
        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          filter · click to toggle
        </div>
        <div className="flex flex-col gap-0.5">
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
      </div>

      <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
        {mode === "semantic"
          ? "drag to pan · scroll to zoom · click a node to open"
          : "drag to orbit · scroll to zoom · click a node to open"}
      </div>
    </div>
  );
}
