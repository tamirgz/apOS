/**
 * Pure ECharts option builder — no echarts import, so it runs on BOTH the server
 * (SSR → svg) and the client (live interactive chart). Theme-aware: light for the
 * standalone/PDF SVG, dark for the in-chat interactive render.
 */
export type ChartType =
  | "bar"
  | "hbar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "treemap"
  | "waterfall"
  | "candlestick";

export interface ChartDatum {
  label: string;
  value?: number;
  // candlestick only:
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  subtitle?: string;
  data: ChartDatum[];
  unit?: "number" | "currency" | "percent";
  width?: number;
  height?: number;
}

const PALETTE = [
  "#3987e5", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#22a022", "#9085e9", "#e34948",
];
const POS = "#12b312";
const NEG = "#e0524f";
const FONT = "ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif";

function theme(dark: boolean) {
  return dark
    ? { bg: "transparent", ink: "#e8e8e3", muted: "#9a9a94", grid: "rgba(255,255,255,0.09)", accent: "#4c9bef" }
    : { bg: "#ffffff", ink: "#1a1a19", muted: "#6b6a66", grid: "#ececE6", accent: "#2a78d6" };
}

export function fmtFn(unit?: string) {
  return (raw: number) => {
    const v = Math.round((Number(raw) + Number.EPSILON) * 100) / 100;
    if (unit === "currency") {
      const n = (Math.abs(v) >= 1000 ? Math.round(Math.abs(v)) : Math.abs(v)).toLocaleString("en-US");
      return (v < 0 ? "-$" : "$") + n;
    }
    if (unit === "percent") return `${v}%`;
    return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(v);
  };
}

export function buildChartOption(spec: ChartSpec, dark = false): Record<string, unknown> {
  const t = theme(dark);
  const f = fmtFn(spec.unit);
  const title = {
    text: spec.title,
    subtext: spec.subtitle,
    left: 18,
    top: 12,
    textStyle: { fontSize: 15, fontWeight: 600 as const, color: t.ink, fontFamily: FONT },
    subtextStyle: { fontSize: 12, color: t.muted, fontFamily: FONT },
  };
  const common = {
    backgroundColor: t.bg,
    color: PALETTE,
    textStyle: { fontFamily: FONT },
    title,
    tooltip: {
      trigger: (spec.type === "pie" || spec.type === "donut" || spec.type === "treemap"
        ? "item"
        : "axis") as "item" | "axis",
      valueFormatter: (v: number) => f(v),
    },
  };

  const catAxis = (labels: string[]) => ({
    type: "category" as const,
    data: labels,
    axisLabel: { color: t.muted, fontSize: 11 },
    axisLine: { lineStyle: { color: t.grid } },
    axisTick: { show: false },
  });
  const valAxis = () => ({
    type: "value" as const,
    axisLabel: { color: t.muted, fontSize: 11, formatter: f },
    splitLine: { lineStyle: { color: t.grid } },
    axisLine: { show: false },
  });

  const labels = spec.data.map((d) => d.label);

  switch (spec.type) {
    case "bar":
    case "hbar": {
      const horizontal = spec.type === "hbar";
      const anyNeg = spec.data.some((d) => (d.value ?? 0) < 0);
      const bars = spec.data.map((d) => ({
        value: d.value ?? 0,
        itemStyle: {
          color: anyNeg ? ((d.value ?? 0) >= 0 ? POS : NEG) : t.accent,
          borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0],
        },
      }));
      return {
        ...common,
        // containLabel:true lets ECharts auto-size the grid to fit the category
        // (symbol) names and the bar-end value labels, so neither clips — the
        // old fixed left/right + containLabel:false clipped long "-$68.90"
        // labels. For a horizontal bar the value sits on the bar END, so the
        // bottom value-axis is redundant clutter (it was overlapping into a
        // garbled row) — hide its labels + gridlines and keep only the bars.
        grid: horizontal
          ? { left: 8, right: 20, top: spec.subtitle ? 74 : 56, bottom: 8, containLabel: true }
          : { left: 8, right: 20, top: spec.subtitle ? 74 : 56, bottom: 8, containLabel: true },
        xAxis: horizontal
          ? { ...valAxis(), axisLabel: { show: false }, splitLine: { show: false } }
          : catAxis(labels),
        yAxis: horizontal ? { ...catAxis(labels), inverse: true } : valAxis(),
        series: [
          {
            type: "bar",
            data: bars,
            barMaxWidth: 26,
            label: {
              show: true,
              position: horizontal ? "right" : "top",
              color: t.muted,
              fontSize: 10,
              formatter: (p: { value: number }) => f(p.value),
            },
          },
        ],
      };
    }

    case "line":
    case "area":
      return {
        ...common,
        grid: { left: 64, right: 24, top: spec.subtitle ? 74 : 56, bottom: 40 },
        xAxis: { ...catAxis(labels), boundaryGap: false },
        yAxis: { ...valAxis(), scale: true },
        series: [
          {
            type: "line",
            data: spec.data.map((d) => d.value ?? 0),
            smooth: true,
            symbol: "none",
            lineStyle: { width: 2, color: t.accent },
            areaStyle: spec.type === "area" ? { color: t.accent, opacity: 0.12 } : undefined,
          },
        ],
      };

    case "pie":
    case "donut": {
      const items = spec.data.filter((d) => (d.value ?? 0) > 0);
      const total = items.reduce((a, d) => a + (d.value ?? 0), 0) || 1;
      return {
        ...common,
        legend: {
          type: "scroll",
          orient: "vertical",
          right: 12,
          top: "middle",
          textStyle: { color: t.ink, fontSize: 11, fontFamily: FONT },
          itemWidth: 12,
          itemHeight: 12,
          formatter: (name: string) => {
            const it = items.find((d) => d.label === name);
            return it ? `${name}  ${Math.round(((it.value ?? 0) / total) * 100)}%` : name;
          },
        },
        series: [
          {
            type: "pie",
            radius: spec.type === "donut" ? ["42%", "70%"] : "68%",
            center: ["34%", "56%"],
            data: items.map((d) => ({ name: d.label, value: d.value ?? 0 })),
            label: { show: false },
            labelLine: { show: false },
          },
        ],
      };
    }

    case "treemap":
      return {
        ...common,
        series: [
          {
            type: "treemap",
            top: spec.subtitle ? 70 : 52,
            roam: false,
            nodeClick: false,
            breadcrumb: { show: false },
            label: { show: true, formatter: "{b}", color: "#fff", fontSize: 12 },
            itemStyle: { borderColor: dark ? "#141413" : "#fff", borderWidth: 2, gapWidth: 2 },
            data: spec.data
              .filter((d) => (d.value ?? 0) > 0)
              .map((d, i) => ({ name: d.label, value: d.value ?? 0, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
          },
        ],
      };

    case "waterfall": {
      // P&L bridge: each value is a delta; render invisible base + visible delta.
      let running = 0;
      const base: number[] = [];
      const up: (number | string)[] = [];
      const down: (number | string)[] = [];
      for (const d of spec.data) {
        const v = d.value ?? 0;
        if (v >= 0) {
          base.push(running);
          up.push(v);
          down.push("-");
        } else {
          base.push(running + v);
          up.push("-");
          down.push(-v);
        }
        running += v;
      }
      return {
        ...common,
        grid: { left: 64, right: 24, top: spec.subtitle ? 74 : 56, bottom: 40 },
        xAxis: catAxis(labels),
        yAxis: valAxis(),
        series: [
          { type: "bar", stack: "wf", itemStyle: { color: "transparent" }, emphasis: { itemStyle: { color: "transparent" } }, data: base, silent: true },
          { type: "bar", stack: "wf", itemStyle: { color: POS, borderRadius: [3, 3, 0, 0] }, data: up, barMaxWidth: 28 },
          { type: "bar", stack: "wf", itemStyle: { color: NEG, borderRadius: [3, 3, 0, 0] }, data: down, barMaxWidth: 28 },
        ],
      };
    }

    case "candlestick": {
      const ohlc = spec.data.map((d) => [d.open ?? 0, d.close ?? 0, d.low ?? 0, d.high ?? 0]);
      return {
        ...common,
        grid: { left: 64, right: 24, top: spec.subtitle ? 74 : 56, bottom: 40 },
        xAxis: catAxis(labels),
        yAxis: { ...valAxis(), scale: true },
        series: [
          {
            type: "candlestick",
            data: ohlc,
            itemStyle: {
              color: POS, color0: NEG, borderColor: POS, borderColor0: NEG,
            },
          },
        ],
      };
    }

    default:
      return common;
  }
}
