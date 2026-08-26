"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrbitGraph as Graph, OrbitNode } from "../queries";

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
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("constellation");
  const [query, setQuery] = useState("");
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

  const matches = (n: GNode) =>
    !queryRef.current || n.title.toLowerCase().includes(queryRef.current);

  // Init once.
  useEffect(() => {
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let g: any;
    let onResize: (() => void) | undefined;
    (async () => {
      const [{ default: ForceGraph3D }, { default: SpriteText }] =
        await Promise.all([
          import("3d-force-graph"),
          import("three-spritetext"),
        ]);
      if (disposed || !holderRef.current) return;
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
          if (!hubIds.has(n.id)) return undefined;
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
    const visible = allNodes.filter((n) => !hidden.has(n.kind));
    // Semantic mode: pin each node to its embedding-projection position; force
    // mode: release it so the simulation lays it out.
    for (const n of visible) {
      if (mode === "semantic" && n.mx != null) {
        n.fx = n.mx;
        n.fy = n.my ?? 0;
        n.fz = n.mz ?? 0;
      } else {
        n.fx = undefined;
        n.fy = undefined;
        n.fz = undefined;
      }
    }
    const ids = new Set(visible.map((n) => n.id));
    const links = data.links.filter(
      (l) => ids.has(l.source) && ids.has(l.target),
    );
    g.graphData({ nodes: visible, links });
    g.controls().autoRotate = mode === "constellation";
    if (mode === "constellation") g.d3ReheatSimulation?.();
    setTimeout(() => {
      try {
        g.zoomToFit(600, 50);
      } catch {
        /* ignore */
      }
    }, mode === "semantic" ? 200 : 1200);
  }, [allNodes, data.links, hidden, ready, mode]);

  // Search → re-highlight (nodes + labels) without rebuilding the graph.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.nodeColor(g.nodeColor());
    g.nodeThreeObject(g.nodeThreeObject());
  }, [query, ready]);

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
            ? "Placed by meaning — nearby stars are about the same thing."
            : "Placed by connection — linked stars pull together."}
        </p>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Highlight… (title match)"
          className="mt-2 h-8 w-full rounded-lg glass px-2.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:glass-edge"
        />
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
        drag to orbit · scroll to zoom · click a node to open
      </div>
    </div>
  );
}
