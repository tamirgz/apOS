"use client";

import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { buildChartOption, type ChartSpec } from "@/core/viz/chartOption";

/**
 * A plain markdown image that degrades gracefully: if the src fails to load
 * (e.g. a model wrote a bad/placeholder chart URL), show a muted note instead of
 * the browser's raw broken-image + alt text.
 */
export function SafeImg({ src, alt }: { src?: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken || !src)
    return (
      <span className="my-2 inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-faint">
        <ImageOff className="size-3.5" />
        {alt ? `${alt} — couldn't be rendered` : "image unavailable"}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      onError={() => setBroken(true)}
      className="my-2 max-w-full rounded-lg border border-white/10 bg-white"
    />
  );
}

/**
 * Renders a viz.chart INTERACTIVELY in-place (hover tooltips, zoom, legend
 * toggles) by fetching its spec (/api/charts/<id>?spec=1) and mounting ECharts
 * client-side (lazy-loaded). Falls back to the static SVG image if the spec
 * isn't available (e.g. an older chart) or ECharts fails to load.
 */
export function ChartEmbed({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(340);

  useEffect(() => {
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any;
    let onResize: (() => void) | undefined;
    (async () => {
      try {
        const specUrl = src + (src.includes("?") ? "&" : "?") + "spec=1";
        const res = await fetch(specUrl);
        if (!res.ok) throw new Error("no spec");
        const spec = (await res.json()) as ChartSpec;
        const h =
          spec.type === "hbar"
            ? Math.max(300, spec.data.length * 30 + 96)
            : spec.type === "pie" || spec.type === "donut" || spec.type === "treemap"
              ? 320
              : 340;
        if (disposed) return;
        setHeight(h);
        const echarts = await import("echarts");
        if (disposed || !ref.current) return;
        chart = echarts.init(ref.current, null, { renderer: "canvas" });
        chart.setOption(buildChartOption(spec, true));
        onResize = () => chart?.resize();
        window.addEventListener("resize", onResize);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      if (chart) chart.dispose();
    };
  }, [src]);

  // Spec fetch failed → fall back to the static SVG, but through SafeImg so a
  // MISSING chart (404 — e.g. a model-fabricated /api/charts/<id> that was never
  // created) degrades to a muted note instead of a raw broken-image icon.
  if (failed) return <SafeImg src={src} alt="chart" />;

  return (
    <div
      ref={ref}
      className="my-2 w-full rounded-lg border border-white/10"
      style={{ height }}
    />
  );
}
