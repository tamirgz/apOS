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
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type GNode = OrbitNode & { val: number; x?: number; y?: number; z?: number };

export function OrbitGraph({ data }: { data: Graph }) {
  const router = useRouter();
  const holderRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Kinds present, most-common first — drives the legend/filter.
  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of data.nodes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  // Stable node objects (the sim mutates x/y/z on these), sized by degree.
  const allNodes = useMemo<GNode[]>(() => {
    const deg = new Map<string, number>();
    for (const l of data.links) {
      deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
      deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
    }
    return data.nodes.map((n) => ({
      ...n,
      val: 1 + Math.min(6, (deg.get(n.id) ?? 0) * 0.5),
    }));
  }, [data]);

  // Init the 3D graph once.
  useEffect(() => {
    let disposed = false;
    // The lib's accessor types are strict about its own NodeObject; our nodes
    // carry extra fields, so treat the instance loosely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let g: any;
    let onResize: (() => void) | undefined;
    (async () => {
      const ForceGraph3D = (await import("3d-force-graph")).default;
      if (disposed || !holderRef.current) return;
      const el = holderRef.current;
      g = new ForceGraph3D(el, { controlType: "orbit" });
      g.backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false)
        .nodeRelSize(4)
        .nodeVal((n: GNode) => n.val)
        .nodeColor((n: GNode) => colorFor(n.kind))
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
        .linkColor(() => "rgba(150,180,210,0.18)")
        .linkWidth(0.5)
        .linkOpacity(0.3)
        .width(el.clientWidth || 800)
        .height(el.clientHeight || 600)
        .onNodeClick((n: GNode) => {
          if (n.href && /^\/m\//.test(n.href)) {
            router.push(n.href);
            return;
          }
          // No detail route (vault/notion/memory/file) → fly to it instead.
          const d = 120;
          const r = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0) || 1;
          g.cameraPosition(
            {
              x: (n.x ?? 0) * (1 + d / r),
              y: (n.y ?? 0) * (1 + d / r),
              z: (n.z ?? 0) * (1 + d / r),
            },
            n,
            800,
          );
        });
      graphRef.current = g;

      // Gentle orbital drift.
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
      // stash the observer for cleanup
      (g.__ro as ResizeObserver) = ro;

      // Frame the whole cloud once the force layout has spread out (and again
      // if it was still 0×0 at init because the pane hadn't been sized yet).
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
  }, [router]);

  // Feed / re-filter data whenever the dataset or the active kinds change.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const visible = allNodes.filter((n) => !hidden.has(n.kind));
    const ids = new Set(visible.map((n) => n.id));
    const links = data.links.filter(
      (l) => ids.has(l.source) && ids.has(l.target),
    );
    g.graphData({ nodes: visible, links });
  }, [allNodes, data.links, hidden]);

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

      {/* header / counts */}
      <div className="pointer-events-none absolute left-4 top-4 z-10">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
          knowledge orbit
        </div>
        <div className="mt-1 text-sm text-ink-dim">
          <span className="text-ink">{shownCount}</span> of {data.total} nodes ·{" "}
          {data.links.length} links
        </div>
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
